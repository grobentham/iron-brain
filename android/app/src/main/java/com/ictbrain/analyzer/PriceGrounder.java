package com.ictbrain.analyzer;

import android.graphics.Bitmap;
import android.graphics.Rect;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Independent local price-axis validator for ICT Brain Android.
 *
 * It does not ask the generative model for prices. Instead it OCRs numeric labels
 * from the right side of a chart, fits a robust linear mapping from image Y to
 * price, rejects outliers, and converts model-selected visual Y anchors to prices.
 */
final class PriceGrounder {
    private static final Pattern PRICE_TOKEN = Pattern.compile("^(?:\\d{1,3}(?:,\\d{3})+|\\d{4,6})(?:\\.\\d{1,2})?$");
    private static final double MIN_PRICE = 1000.0;
    private static final double MAX_PRICE = 100000.0;
    private static final double MAX_RESIDUAL_POINTS = 1.50;
    private static final double MIN_Y_SPAN = 0.12;
    private static final double MIN_R2 = 0.985;
    private static final double EXTRAPOLATION_MARGIN = 0.055;

    private PriceGrounder() {}

    static Calibration calibrate(Bitmap bitmap) {
        if (bitmap == null || bitmap.isRecycled() || bitmap.getWidth() < 50 || bitmap.getHeight() < 50) {
            return Calibration.invalid("image unavailable");
        }

        TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        try {
            Text text = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)));
            List<Sample> samples = new ArrayList<>();
            int width = bitmap.getWidth();
            int height = bitmap.getHeight();

            for (Text.TextBlock block : text.getTextBlocks()) {
                for (Text.Line line : block.getLines()) {
                    for (Text.Element element : line.getElements()) {
                        Rect box = element.getBoundingBox();
                        if (box == null) continue;
                        double centerX = box.exactCenterX() / width;
                        if (centerX < 0.74) continue;
                        String token = element.getText() == null ? "" : element.getText().trim();
                        if (!PRICE_TOKEN.matcher(token).matches()) continue;
                        double price;
                        try {
                            price = Double.parseDouble(token.replace(",", ""));
                        } catch (NumberFormatException ignored) {
                            continue;
                        }
                        if (!Double.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
                        double y = clamp(box.exactCenterY() / height, 0.0, 1.0);
                        samples.add(new Sample(y, price, token));
                    }
                }
            }

            samples = dedupe(samples);
            if (samples.size() < 3) {
                return Calibration.invalid("fewer than 3 usable right-axis price labels", samples);
            }
            return robustFit(samples);
        } catch (Throwable e) {
            return Calibration.invalid("OCR failed: " + safeMessage(e));
        } finally {
            try { recognizer.close(); } catch (Throwable ignored) {}
        }
    }

    private static Calibration robustFit(List<Sample> samples) {
        Candidate best = null;
        for (int i = 0; i < samples.size(); i++) {
            for (int j = i + 1; j < samples.size(); j++) {
                Sample a = samples.get(i);
                Sample b = samples.get(j);
                double dy = b.y - a.y;
                if (Math.abs(dy) < 0.035) continue;
                double slope = (b.price - a.price) / dy;
                // Android image Y grows downward, so a normal price scale must decline as Y grows.
                if (!Double.isFinite(slope) || slope >= -0.01) continue;
                double intercept = a.price - slope * a.y;
                List<Sample> inliers = new ArrayList<>();
                double error = 0.0;
                for (Sample s : samples) {
                    double residual = Math.abs((slope * s.y + intercept) - s.price);
                    if (residual <= MAX_RESIDUAL_POINTS) {
                        inliers.add(s);
                        error += residual;
                    }
                }
                if (inliers.size() < 3) continue;
                double span = ySpan(inliers);
                Candidate c = new Candidate(inliers, span, error);
                if (best == null || c.betterThan(best)) best = c;
            }
        }

        if (best == null) return Calibration.invalid("price labels did not form a consistent vertical scale", samples);

        Fit fit = leastSquares(best.inliers);
        if (fit == null || fit.slope >= 0) return Calibration.invalid("price-axis direction was invalid", samples);
        double span = ySpan(best.inliers);
        double priceSpan = priceSpan(best.inliers);
        if (best.inliers.size() < 3 || span < MIN_Y_SPAN || fit.r2 < MIN_R2 || priceSpan < 2.0) {
            return Calibration.invalid(String.format(Locale.US,
                    "weak price calibration (%d labels, span %.2f, R² %.4f)",
                    best.inliers.size(), span, fit.r2), samples);
        }

        double minY = 1.0;
        double maxY = 0.0;
        for (Sample s : best.inliers) {
            minY = Math.min(minY, s.y);
            maxY = Math.max(maxY, s.y);
        }
        return new Calibration(true, fit.slope, fit.intercept, fit.r2,
                best.inliers.size(), minY, maxY, best.inliers,
                String.format(Locale.US, "STRONG · %d labels · R² %.4f", best.inliers.size(), fit.r2));
    }

    private static Fit leastSquares(List<Sample> samples) {
        if (samples.size() < 2) return null;
        double meanY = 0.0;
        double meanP = 0.0;
        for (Sample s : samples) {
            meanY += s.y;
            meanP += s.price;
        }
        meanY /= samples.size();
        meanP /= samples.size();
        double sxx = 0.0;
        double sxy = 0.0;
        double sst = 0.0;
        for (Sample s : samples) {
            double dy = s.y - meanY;
            double dp = s.price - meanP;
            sxx += dy * dy;
            sxy += dy * dp;
            sst += dp * dp;
        }
        if (sxx <= 1e-9 || sst <= 1e-9) return null;
        double slope = sxy / sxx;
        double intercept = meanP - slope * meanY;
        double sse = 0.0;
        for (Sample s : samples) {
            double e = s.price - (slope * s.y + intercept);
            sse += e * e;
        }
        double r2 = 1.0 - (sse / sst);
        return new Fit(slope, intercept, r2);
    }

    private static List<Sample> dedupe(List<Sample> samples) {
        samples.sort(Comparator.comparingDouble(s -> s.y));
        List<Sample> out = new ArrayList<>();
        for (Sample s : samples) {
            boolean duplicate = false;
            for (Sample existing : out) {
                if (Math.abs(existing.y - s.y) < 0.004 && Math.abs(existing.price - s.price) < 0.26) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) out.add(s);
        }
        return out;
    }

    private static double ySpan(List<Sample> samples) {
        double min = 1.0, max = 0.0;
        for (Sample s : samples) {
            min = Math.min(min, s.y);
            max = Math.max(max, s.y);
        }
        return max - min;
    }

    private static double priceSpan(List<Sample> samples) {
        double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
        for (Sample s : samples) {
            min = Math.min(min, s.price);
            max = Math.max(max, s.price);
        }
        return max - min;
    }

    private static double clamp(double value, double lo, double hi) {
        return Math.max(lo, Math.min(hi, value));
    }

    private static String safeMessage(Throwable e) {
        Throwable x = e;
        while (x.getCause() != null) x = x.getCause();
        String m = x.getMessage();
        return (m == null || m.isBlank()) ? x.getClass().getSimpleName() : m;
    }

    static final class Calibration {
        final boolean strong;
        final double slope;
        final double intercept;
        final double r2;
        final int inlierCount;
        final double minY;
        final double maxY;
        final List<Sample> samples;
        final String status;

        private Calibration(boolean strong, double slope, double intercept, double r2,
                            int inlierCount, double minY, double maxY,
                            List<Sample> samples, String status) {
            this.strong = strong;
            this.slope = slope;
            this.intercept = intercept;
            this.r2 = r2;
            this.inlierCount = inlierCount;
            this.minY = minY;
            this.maxY = maxY;
            this.samples = new ArrayList<>(samples);
            this.status = status;
        }

        static Calibration invalid(String reason) {
            return invalid(reason, new ArrayList<>());
        }

        static Calibration invalid(String reason, List<Sample> samples) {
            return new Calibration(false, Double.NaN, Double.NaN, Double.NaN,
                    0, Double.NaN, Double.NaN, samples, "UNUSABLE · " + reason);
        }

        double priceForPermille(int yPermille) {
            if (!strong || yPermille < 0 || yPermille > 1000) return Double.NaN;
            double y = yPermille / 1000.0;
            if (y < minY - EXTRAPOLATION_MARGIN || y > maxY + EXTRAPOLATION_MARGIN) return Double.NaN;
            double price = slope * y + intercept;
            if (!Double.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) return Double.NaN;
            return Math.round(price * 4.0) / 4.0;
        }

        String promptSummary() {
            if (!strong) return status;
            StringBuilder sb = new StringBuilder(status).append(" · OCR labels ");
            int shown = 0;
            for (Sample s : samples) {
                if (shown++ >= 6) break;
                if (shown > 1) sb.append(", ");
                sb.append(s.raw).append("@y=").append(Math.round(s.y * 1000));
            }
            return sb.toString();
        }
    }

    static final class Sample {
        final double y;
        final double price;
        final String raw;
        Sample(double y, double price, String raw) {
            this.y = y;
            this.price = price;
            this.raw = raw;
        }
    }

    private static final class Candidate {
        final List<Sample> inliers;
        final double span;
        final double error;
        Candidate(List<Sample> inliers, double span, double error) {
            this.inliers = inliers;
            this.span = span;
            this.error = error;
        }
        boolean betterThan(Candidate other) {
            if (inliers.size() != other.inliers.size()) return inliers.size() > other.inliers.size();
            if (Math.abs(span - other.span) > 1e-9) return span > other.span;
            return error < other.error;
        }
    }

    private static final class Fit {
        final double slope;
        final double intercept;
        final double r2;
        Fit(double slope, double intercept, double r2) {
            this.slope = slope;
            this.intercept = intercept;
            this.r2 = r2;
        }
    }
}
