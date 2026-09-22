package com.ictbrain.analyzer;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.ArrayAdapter;
import android.widget.TextView;
import android.widget.Toast;

import com.google.mlkit.genai.common.DownloadCallback;
import com.google.mlkit.genai.common.FeatureStatus;
import com.google.mlkit.genai.common.GenAiException;
import com.google.mlkit.genai.prompt.Content;
import com.google.mlkit.genai.prompt.GenerateContentRequest;
import com.google.mlkit.genai.prompt.GenerateContentResponse;
import com.google.mlkit.genai.prompt.Generation;
import com.google.mlkit.genai.prompt.java.GenerativeModelFutures;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.text.DecimalFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ICT Brain Android v2.0.0
 * Screenshot-only, on-device chart analysis using Android AICore / Gemini Nano through
 * ML Kit Prompt API. No broker execution and no external AI API credential.
 */
public class MainActivity extends Activity {
    private static final int PICK_IMAGES = 4107;
    private static final int MAX_IMAGES = 4;
    private static final int BG = Color.rgb(244, 241, 233);
    private static final int INK = Color.rgb(28, 31, 29);
    private static final int MUTED = Color.rgb(105, 104, 96);
    private static final int GREEN = Color.rgb(34, 55, 45);
    private static final int PALE_GREEN = Color.rgb(229, 235, 230);
    private static final int LINE = Color.rgb(214, 211, 202);
    private static final int RED = Color.rgb(132, 52, 45);

    private static final String[] INSTRUMENTS = {"AUTO", "NQ", "MNQ", "ES"};
    private static final String[] TIMEFRAMES = {"AUTO", "1m", "3m", "5m", "15m", "30m", "1H", "4H", "1D"};

    private static final String PROMPT = """
You are ICT Brain, an evidence-constrained NQ/MNQ futures chart analyzer. Analyze ONLY the screenshots attached in this request. Screenshots are ordered and individually labeled. Do not use hidden market data, current prices, news, or information not visible in the images.

PRIMARY OBJECTIVE
Return at most ONE fixed trade. Never return multiple setups, backup trades, alternate directions, scale-ins, runners, TP2, or TP3. A valid actionable result has exactly one direction, one entry, one stop, and one fixed take-profit. If the evidence is incomplete, conflicting, price scale is unreadable, or no setup is complete, return NO_TRADE.

TIMEFRAME HIERARCHY
When supplied, use 1H NQ for higher-timeframe narrative and draw on liquidity; 15m NQ for session structure/key liquidity; 5m MNQ for setup formation; 1m MNQ for execution precision. Do not invent a missing higher-timeframe view.

VISIBLE EVIDENCE TO CHECK
Market structure and swing points; external/internal liquidity; equal highs/lows; previous/session highs/lows when visibly labeled; liquidity sweeps/raids; displacement; BOS/CHoCH/MSS; FVG/IFVG; order block, breaker, mitigation or rejection block; premium/discount and dealing range; SMT only if the required correlated NQ/ES evidence is actually present; session/time context only if readable; 10AM-open behavior only if the screenshot visibly supports it.

OPERATIONAL SETUPS
S01 Liquidity Raid Reversal: meaningful liquidity sweep/raid -> rejection/displacement -> structural shift -> retrace/entry evidence.
S02 NQ/ES SMT Reversal: visible correlated divergence at meaningful swing/liquidity + displacement/structural shift. Never claim SMT without both markets visible.
S03 10AM Manipulation: visible 10:00 ET open context; manipulation through one side/open; close back through the 10AM open; retest/continuation evidence.
S04 Judas Swing: session opening false move/raid against the intended directional expansion, followed by displacement/shift and retrace.
S05 Breaker Retest: failed order-block structure becomes a breaker; displacement confirms; retest provides entry.
S06 HTF Continuation: higher-timeframe directional structure/DOL aligned with lower-timeframe displacement and retrace.
S08 AMD / Power of Three: visible accumulation -> manipulation -> distribution sequence with valid execution evidence.
S09 Rejection Block: clear rejection block at meaningful liquidity/PD context plus confirmation.
S10 Silver Bullet: only when the screenshot visibly supports the appropriate NY time window and liquidity/FVG sequence.
S11 2022 Mentorship Model: liquidity draw + raid/displacement + market structure shift + FVG retrace with sufficient visible context.
S12 Turtle Soup: false breakout/raid of a meaningful prior high/low followed by rejection and reversal confirmation.
S07 and S13-S18 are NOT executable in this app. Never select them.

PRICE RULES
Use exact numeric entry/stop/target ONLY when the price scale/labels and candle location are clear enough to support those numbers. Never fabricate precision. NQ/MNQ/ES prices trade in 0.25-point increments. If exact levels cannot be grounded, choose NO_TRADE. For LONG require stop < entry < target. For SHORT require target < entry < stop.

BIAS / DOL
Bias must be BULLISH, BEARISH, NEUTRAL, or UNCLEAR. DOL should name the visible liquidity objective concisely. Confidence is confidence in the screenshot evidence, NOT win probability.

OUTPUT
Return ONLY one JSON object, with no Markdown and no text before/after it:
{
  "decision":"LONG|SHORT|NO_TRADE",
  "setup_id":"S01|S02|S03|S04|S05|S06|S08|S09|S10|S11|S12|NONE",
  "setup":"short setup name",
  "instrument":"NQ|MNQ|ES|UNKNOWN",
  "bias":"BULLISH|BEARISH|NEUTRAL|UNCLEAR",
  "dol":"short visible draw on liquidity or UNCLEAR",
  "entry":12345.25,
  "stop":12340.25,
  "target":12355.25,
  "confidence":75,
  "why":["evidence 1","evidence 2","evidence 3"],
  "uncertainty":["material uncertainty if any"]
}
For NO_TRADE set setup_id to NONE and entry/stop/target to null. Keep why concise and evidence-based.
""";

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final List<ChartShot> shots = new ArrayList<>();
    private GenerativeModelFutures model;
    private LinearLayout shotsContainer;
    private LinearLayout resultContainer;
    private TextView modelStatus;
    private TextView selectedCount;
    private Button prepareButton;
    private Button analyzeButton;
    private ProgressBar progress;
    private EditText contextInput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        model = GenerativeModelFutures.from(Generation.INSTANCE.getClient());
        buildUi();
        refreshModelStatus();
    }

    @Override
    protected void onDestroy() {
        ioExecutor.shutdownNow();
        for (ChartShot shot : shots) {
            if (shot.bitmap != null && !shot.bitmap.isRecycled()) shot.bitmap.recycle();
        }
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(18), dp(24), dp(48));
        scroll.addView(page, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView eyebrow = text("ICT BRAIN  /  ON-DEVICE", 11, GREEN, Typeface.BOLD);
        eyebrow.setLetterSpacing(0.12f);
        page.addView(eyebrow);
        TextView hero = text("See the chart.\nFind one trade.", 38, INK, Typeface.NORMAL);
        hero.setTypeface(Typeface.create("serif", Typeface.NORMAL));
        hero.setLineSpacing(0, 0.94f);
        page.addView(hero, topMargin(10));
        TextView sub = text("Add up to four TradingView screenshots. ICT Brain reads them locally and returns one fixed plan — or tells you to wait.", 15, MUTED, Typeface.NORMAL);
        sub.setLineSpacing(dp(3), 1f);
        page.addView(sub, topMargin(14));

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        statusRow.setPadding(dp(14), dp(12), dp(14), dp(12));
        statusRow.setBackground(rounded(PALE_GREEN, 18, 0, Color.TRANSPARENT));
        modelStatus = text("Checking on-device AI…", 13, GREEN, Typeface.BOLD);
        statusRow.addView(modelStatus, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        prepareButton = smallButton("Prepare AI");
        prepareButton.setVisibility(View.GONE);
        prepareButton.setOnClickListener(v -> downloadModel());
        statusRow.addView(prepareButton);
        page.addView(statusRow, topMargin(24));
        divider(page, 26);

        TextView section = text("Your charts", 23, INK, Typeface.NORMAL);
        section.setTypeface(Typeface.create("serif", Typeface.NORMAL));
        page.addView(section);
        selectedCount = text("0 of 4 screenshots", 13, MUTED, Typeface.NORMAL);
        page.addView(selectedCount, topMargin(5));
        Button choose = outlineButton("Choose screenshots");
        choose.setOnClickListener(v -> openPicker());
        page.addView(choose, topMargin(15));
        shotsContainer = new LinearLayout(this);
        shotsContainer.setOrientation(LinearLayout.VERTICAL);
        page.addView(shotsContainer, topMargin(8));
        TextView hint = text("Recommended: 1H NQ · 15m NQ · 5m MNQ · 1m MNQ", 12, MUTED, Typeface.NORMAL);
        page.addView(hint, topMargin(8));

        TextView contextLabel = text("Optional context", 13, INK, Typeface.BOLD);
        page.addView(contextLabel, topMargin(24));
        contextInput = new EditText(this);
        contextInput.setHint("e.g. NY session, looking for 10AM setup");
        contextInput.setHintTextColor(Color.rgb(145, 142, 134));
        contextInput.setTextColor(INK);
        contextInput.setTextSize(14);
        contextInput.setSingleLine(false);
        contextInput.setMinLines(2);
        contextInput.setMaxLines(4);
        contextInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        contextInput.setBackground(rounded(Color.TRANSPARENT, 14, 1, LINE));
        page.addView(contextInput, topMargin(8));

        analyzeButton = primaryButton("Find one trade");
        analyzeButton.setEnabled(false);
        analyzeButton.setAlpha(0.45f);
        analyzeButton.setOnClickListener(v -> analyze());
        page.addView(analyzeButton, topMargin(22));
        progress = new ProgressBar(this);
        progress.setVisibility(View.GONE);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(dp(30), dp(30));
        pp.gravity = Gravity.CENTER_HORIZONTAL;
        pp.topMargin = dp(16);
        page.addView(progress, pp);
        resultContainer = new LinearLayout(this);
        resultContainer.setOrientation(LinearLayout.VERTICAL);
        resultContainer.setVisibility(View.GONE);
        page.addView(resultContainer, topMargin(26));

        divider(page, 32);
        TextView privacy = text("PRIVATE BY DESIGN", 10, MUTED, Typeface.BOLD);
        privacy.setLetterSpacing(0.12f);
        page.addView(privacy);
        TextView privacyBody = text("The analysis request is handled by Android's on-device model through AICore on supported phones. This app contains no external AI key, broker connection, or trade execution.", 12, MUTED, Typeface.NORMAL);
        privacyBody.setLineSpacing(dp(2), 1f);
        page.addView(privacyBody, topMargin(8));
        setContentView(scroll);
    }

    private void refreshModelStatus() {
        modelStatus.setText("Checking on-device AI…");
        prepareButton.setVisibility(View.GONE);
        ioExecutor.execute(() -> {
            try {
                int status = model.checkStatus().get();
                runOnUiThread(() -> applyModelStatus(status));
            } catch (Throwable e) {
                runOnUiThread(() -> {
                    modelStatus.setText("On-device AI unavailable on this phone");
                    setAnalyzeEnabled(false);
                });
            }
        });
    }

    private void applyModelStatus(int status) {
        if (status == FeatureStatus.AVAILABLE) {
            modelStatus.setText("On-device AI ready");
            prepareButton.setVisibility(View.GONE);
            setAnalyzeEnabled(!shots.isEmpty());
            ioExecutor.execute(() -> { try { model.warmup().get(); } catch (Throwable ignored) {} });
        } else if (status == FeatureStatus.DOWNLOADABLE) {
            modelStatus.setText("On-device AI needs a one-time model download");
            prepareButton.setVisibility(View.VISIBLE);
            setAnalyzeEnabled(false);
        } else if (status == FeatureStatus.DOWNLOADING) {
            modelStatus.setText("Preparing on-device AI…");
            prepareButton.setVisibility(View.GONE);
            setAnalyzeEnabled(false);
        } else {
            modelStatus.setText("On-device AI is not supported on this phone");
            prepareButton.setVisibility(View.GONE);
            setAnalyzeEnabled(false);
        }
    }

    private void downloadModel() {
        prepareButton.setEnabled(false);
        modelStatus.setText("Starting model download…");
        try {
            model.download(new DownloadCallback() {
                @Override public void onDownloadStarted(long bytesToDownload) { runOnUiThread(() -> modelStatus.setText("Downloading on-device AI…")); }
                @Override public void onDownloadProgress(long totalBytesDownloaded) { runOnUiThread(() -> modelStatus.setText("Downloading on-device AI…")); }
                @Override public void onDownloadCompleted() { runOnUiThread(() -> { prepareButton.setEnabled(true); refreshModelStatus(); }); }
                @Override public void onDownloadFailed(GenAiException e) { runOnUiThread(() -> { prepareButton.setEnabled(true); modelStatus.setText("Model download failed — tap Prepare AI to retry"); }); }
            });
        } catch (Throwable e) {
            prepareButton.setEnabled(true);
            modelStatus.setText("Could not start model download");
        }
    }

    private void openPicker() {
        if (shots.size() >= MAX_IMAGES) {
            Toast.makeText(this, "Four screenshots are already selected.", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, PICK_IMAGES);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_IMAGES || resultCode != RESULT_OK || data == null) return;
        List<Uri> newUris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount() && shots.size() + newUris.size() < MAX_IMAGES; i++) newUris.add(clip.getItemAt(i).getUri());
        } else if (data.getData() != null) newUris.add(data.getData());
        if (newUris.isEmpty()) return;
        progress.setVisibility(View.VISIBLE);
        ioExecutor.execute(() -> {
            List<ChartShot> decoded = new ArrayList<>();
            for (Uri uri : newUris) {
                try {
                    Bitmap bitmap = decodeScaledBitmap(uri, 1800);
                    if (bitmap != null) decoded.add(new ChartShot(uri, bitmap));
                } catch (Throwable ignored) {}
            }
            runOnUiThread(() -> {
                progress.setVisibility(View.GONE);
                shots.addAll(decoded);
                applyRecommendedLabels();
                renderShots();
                refreshModelStatus();
            });
        });
    }

    private void applyRecommendedLabels() {
        String[] instr = {"NQ", "NQ", "MNQ", "MNQ"};
        String[] tf = {"1H", "15m", "5m", "1m"};
        for (int i = 0; i < shots.size() && i < 4; i++) {
            ChartShot s = shots.get(i);
            if ("AUTO".equals(s.instrument)) s.instrument = instr[i];
            if ("AUTO".equals(s.timeframe)) s.timeframe = tf[i];
        }
    }

    private void renderShots() {
        shotsContainer.removeAllViews();
        selectedCount.setText(shots.size() + " of 4 screenshots");
        for (int i = 0; i < shots.size(); i++) {
            final int index = i;
            ChartShot shot = shots.get(i);
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.HORIZONTAL);
            card.setGravity(Gravity.CENTER_VERTICAL);
            card.setPadding(dp(10), dp(10), dp(8), dp(10));
            card.setBackground(rounded(Color.TRANSPARENT, 14, 1, LINE));
            ImageView thumb = new ImageView(this);
            thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
            thumb.setImageBitmap(shot.bitmap);
            card.addView(thumb, new LinearLayout.LayoutParams(dp(76), dp(76)));
            LinearLayout controls = new LinearLayout(this);
            controls.setOrientation(LinearLayout.VERTICAL);
            controls.setPadding(dp(10), 0, 0, 0);
            controls.addView(text("Screenshot " + (i + 1), 11, MUTED, Typeface.BOLD));
            LinearLayout spinners = new LinearLayout(this);
            spinners.setOrientation(LinearLayout.HORIZONTAL);
            Spinner instrument = spinner(INSTRUMENTS, shot.instrument);
            Spinner timeframe = spinner(TIMEFRAMES, shot.timeframe);
            spinners.addView(instrument, new LinearLayout.LayoutParams(0, dp(46), 1));
            LinearLayout.LayoutParams tfp = new LinearLayout.LayoutParams(0, dp(46), 1);
            tfp.leftMargin = dp(4);
            spinners.addView(timeframe, tfp);
            controls.addView(spinners, topMargin(4));
            instrument.setOnItemSelectedListener(new SimpleItemListener(pos -> shot.instrument = INSTRUMENTS[pos]));
            timeframe.setOnItemSelectedListener(new SimpleItemListener(pos -> shot.timeframe = TIMEFRAMES[pos]));
            card.addView(controls, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            Button remove = smallButton("×");
            remove.setContentDescription("Remove screenshot " + (i + 1));
            remove.setOnClickListener(v -> {
                ChartShot removed = shots.remove(index);
                if (removed.bitmap != null && !removed.bitmap.isRecycled()) removed.bitmap.recycle();
                renderShots();
                refreshModelStatus();
            });
            card.addView(remove, new LinearLayout.LayoutParams(dp(42), dp(42)));
            shotsContainer.addView(card, topMargin(8));
        }
        setAnalyzeEnabled(!shots.isEmpty() && modelStatus.getText().toString().contains("ready"));
    }

    private void analyze() {
        if (shots.isEmpty()) {
            Toast.makeText(this, "Add at least one screenshot.", Toast.LENGTH_SHORT).show();
            return;
        }
        setAnalyzeEnabled(false);
        progress.setVisibility(View.VISIBLE);
        resultContainer.setVisibility(View.GONE);
        modelStatus.setText("Reading chart evidence on-device…");
        List<ChartShot> snapshot = new ArrayList<>(shots);
        String optional = contextInput.getText().toString().trim();
        ioExecutor.execute(() -> {
            TradePlan plan;
            try {
                int status = model.checkStatus().get();
                if (status != FeatureStatus.AVAILABLE) throw new IllegalStateException("AI model is not ready");
                Content.Builder content = new Content.Builder();
                for (int i = 0; i < snapshot.size() && i < MAX_IMAGES; i++) {
                    ChartShot s = snapshot.get(i);
                    content.text("Screenshot " + (i + 1) + " — instrument=" + s.instrument + ", timeframe=" + s.timeframe + ".");
                    content.image(s.bitmap);
                }
                if (!optional.isEmpty()) content.text("User context (context only, not evidence): " + optional);
                content.text(PROMPT);
                GenerateContentRequest.Builder rb = new GenerateContentRequest.Builder(content.build());
                rb.setTemperature(0.0f);
                rb.setCandidateCount(1);
                rb.setSeed(29);
                rb.setMaxOutputTokens(1400);
                GenerateContentResponse response = model.generateContent(rb.build()).get();
                String raw = response.getCandidates().get(0).getText();
                plan = parseAndValidate(raw);
            } catch (Throwable e) {
                plan = TradePlan.waitPlan("Analysis could not complete on this device. " + safeMessage(e));
            }
            TradePlan finalPlan = plan;
            runOnUiThread(() -> {
                progress.setVisibility(View.GONE);
                modelStatus.setText("On-device AI ready");
                setAnalyzeEnabled(true);
                showResult(finalPlan);
            });
        });
    }

    private TradePlan parseAndValidate(String raw) {
        if (raw == null || raw.trim().isEmpty()) return TradePlan.waitPlan("The on-device model returned no usable result.");
        try {
            int a = raw.indexOf('{');
            int b = raw.lastIndexOf('}');
            if (a < 0 || b <= a) return TradePlan.waitPlan("The analysis response was not structured enough to validate.");
            JSONObject o = new JSONObject(raw.substring(a, b + 1));
            String decision = upper(o.optString("decision", "NO_TRADE"));
            String setupId = upper(o.optString("setup_id", "NONE"));
            String setup = clean(o.optString("setup", "No validated setup"));
            String instrument = upper(o.optString("instrument", "UNKNOWN"));
            String bias = upper(o.optString("bias", "UNCLEAR"));
            String dol = clean(o.optString("dol", "UNCLEAR"));
            int confidence = Math.max(0, Math.min(100, o.optInt("confidence", 0)));
            List<String> why = jsonStrings(o.optJSONArray("why"));
            List<String> uncertainty = jsonStrings(o.optJSONArray("uncertainty"));
            if (!decision.equals("LONG") && !decision.equals("SHORT")) return TradePlan.waitPlanWithContext(setup, instrument, bias, dol, confidence, why, uncertainty);
            if (!isSupportedSetup(setupId)) return TradePlan.waitPlan("The model did not identify a supported, executable ICT setup.");
            if (o.isNull("entry") || o.isNull("stop") || o.isNull("target")) return TradePlan.waitPlan("Exact execution prices were not grounded clearly enough in the screenshot.");
            double entry = tick(o.getDouble("entry"));
            double stop = tick(o.getDouble("stop"));
            double target = tick(o.getDouble("target"));
            if (!Double.isFinite(entry) || !Double.isFinite(stop) || !Double.isFinite(target) || entry <= 0 || stop <= 0 || target <= 0) return TradePlan.waitPlan("The chart did not provide valid executable prices.");
            boolean geometry = decision.equals("LONG") ? (stop < entry && entry < target) : (target < entry && entry < stop);
            if (!geometry) return TradePlan.waitPlan("The proposed entry, stop, and target failed local trade-geometry validation.");
            double risk = Math.abs(entry - stop);
            double reward = Math.abs(target - entry);
            if (risk < 0.25 || reward < 0.25) return TradePlan.waitPlan("The proposed risk or reward collapsed after tick validation.");
            return new TradePlan(decision, setupId, setup, instrument, bias, dol, entry, stop, target, reward / risk, confidence, why, uncertainty);
        } catch (Throwable e) {
            return TradePlan.waitPlan("The on-device result could not be safely validated. No trade returned.");
        }
    }

    private void showResult(TradePlan p) {
        resultContainer.removeAllViews();
        resultContainer.setVisibility(View.VISIBLE);
        divider(resultContainer, 0);
        TextView kicker = text(p.actionable() ? "ONE FIXED TRADE" : "CURRENT DECISION", 10, MUTED, Typeface.BOLD);
        kicker.setLetterSpacing(0.12f);
        resultContainer.addView(kicker, topMargin(24));
        int actionColor = p.decision.equals("LONG") ? GREEN : p.decision.equals("SHORT") ? RED : INK;
        TextView direction = text(p.actionable() ? p.decision : "WAIT", 42, actionColor, Typeface.BOLD);
        direction.setTypeface(Typeface.create("serif", Typeface.BOLD));
        resultContainer.addView(direction, topMargin(5));
        resultContainer.addView(text(p.actionable() ? p.setupId + "  ·  " + p.setup : "No valid fixed trade", 14, INK, Typeface.BOLD), topMargin(3));
        TextView context = text(p.instrument + "  ·  " + p.bias + " bias\nDOL  " + p.dol, 13, MUTED, Typeface.NORMAL);
        context.setLineSpacing(dp(3), 1f);
        resultContainer.addView(context, topMargin(10));
        if (p.actionable()) {
            LinearLayout metrics = new LinearLayout(this);
            metrics.setOrientation(LinearLayout.VERTICAL);
            metrics.setPadding(0, dp(8), 0, dp(8));
            metrics.addView(metricRow("ENTRY", price(p.entry)));
            metrics.addView(metricRow("STOP", price(p.stop)));
            metrics.addView(metricRow("FIXED TAKE PROFIT", price(p.target)));
            metrics.addView(metricRow("R:R", "1 : " + new DecimalFormat("0.00").format(p.rr)));
            resultContainer.addView(metrics, topMargin(18));
        }
        divider(resultContainer, 20);
        TextView whyTitle = text("Why this decision", 19, INK, Typeface.NORMAL);
        whyTitle.setTypeface(Typeface.create("serif", Typeface.NORMAL));
        resultContainer.addView(whyTitle, topMargin(18));
        List<String> reasons = p.why.isEmpty() ? java.util.Collections.singletonList("Evidence was not strong enough for a validated fixed trade.") : p.why;
        for (String reason : reasons) {
            TextView r = text("•  " + reason, 13, INK, Typeface.NORMAL);
            r.setLineSpacing(dp(2), 1f);
            resultContainer.addView(r, topMargin(8));
        }
        if (!p.uncertainty.isEmpty()) resultContainer.addView(text("Uncertainty  ·  " + String.join(" · ", p.uncertainty), 12, MUTED, Typeface.NORMAL), topMargin(14));
        resultContainer.addView(text("Evidence confidence  " + p.confidence + "%", 12, MUTED, Typeface.BOLD), topMargin(16));
        resultContainer.addView(text("Confidence describes visible evidence quality — not the probability that the trade will win.", 11, MUTED, Typeface.NORMAL), topMargin(4));
    }

    private View metricRow(String label, String value) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(9), 0, dp(9));
        TextView l = text(label, 11, MUTED, Typeface.BOLD);
        l.setLetterSpacing(0.08f);
        TextView v = text(value, 19, INK, Typeface.BOLD);
        v.setGravity(Gravity.END);
        row.addView(l, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        row.addView(v);
        return row;
    }

    private Bitmap decodeScaledBitmap(Uri uri, int maxDimension) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, bounds); }
        int sample = 1;
        int max = Math.max(bounds.outWidth, bounds.outHeight);
        while (max / sample > maxDimension * 2) sample *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = sample;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap decoded;
        try (InputStream in = getContentResolver().openInputStream(uri)) { decoded = BitmapFactory.decodeStream(in, null, opts); }
        if (decoded == null) return null;
        int w = decoded.getWidth(), h = decoded.getHeight(), longest = Math.max(w, h);
        if (longest <= maxDimension) return decoded;
        float scale = maxDimension / (float) longest;
        Bitmap scaled = Bitmap.createScaledBitmap(decoded, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), true);
        if (scaled != decoded) decoded.recycle();
        return scaled;
    }

    private boolean isSupportedSetup(String id) { return id.matches("S01|S02|S03|S04|S05|S06|S08|S09|S10|S11|S12"); }
    private static double tick(double v) { return Math.round(v * 4.0) / 4.0; }
    private static String upper(String s) { return s == null ? "" : s.trim().toUpperCase(Locale.US); }
    private static String clean(String s) { return s == null ? "" : s.replace('\n', ' ').trim(); }
    private static String safeMessage(Throwable e) {
        Throwable x = e;
        while (x.getCause() != null) x = x.getCause();
        String m = x.getMessage();
        return (m == null || m.trim().isEmpty()) ? x.getClass().getSimpleName() : m;
    }
    private static List<String> jsonStrings(JSONArray a) {
        List<String> out = new ArrayList<>();
        if (a == null) return out;
        for (int i = 0; i < a.length() && out.size() < 5; i++) {
            String s = clean(a.optString(i, ""));
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }
    private static String price(double v) { return String.format(Locale.US, "%,.2f", v); }

    private TextView text(String value, float sp, int color, int style) {
        TextView t = new TextView(this);
        t.setText(value); t.setTextSize(sp); t.setTextColor(color); t.setTypeface(Typeface.create("sans", style));
        return t;
    }
    private Button primaryButton(String label) {
        Button b = new Button(this); b.setAllCaps(false); b.setText(label); b.setTextColor(Color.WHITE); b.setTextSize(15); b.setTypeface(Typeface.DEFAULT_BOLD); b.setGravity(Gravity.CENTER); b.setPadding(dp(16), dp(12), dp(16), dp(12)); b.setBackground(rounded(INK, 28, 0, Color.TRANSPARENT)); b.setMinHeight(dp(56)); return b;
    }
    private Button outlineButton(String label) {
        Button b = new Button(this); b.setAllCaps(false); b.setText(label); b.setTextColor(INK); b.setTextSize(14); b.setTypeface(Typeface.DEFAULT_BOLD); b.setBackground(rounded(Color.TRANSPARENT, 24, 1, INK)); b.setMinHeight(dp(50)); return b;
    }
    private Button smallButton(String label) {
        Button b = new Button(this); b.setAllCaps(false); b.setText(label); b.setTextSize(12); b.setTextColor(GREEN); b.setBackground(rounded(Color.TRANSPARENT, 18, 1, LINE)); b.setPadding(dp(8), 0, dp(8), 0); b.setMinHeight(0); b.setMinWidth(0); return b;
    }
    private Spinner spinner(String[] values, String selected) {
        Spinner s = new Spinner(this, Spinner.MODE_DROPDOWN);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, values);
        s.setAdapter(adapter);
        int pos = 0; for (int i = 0; i < values.length; i++) if (values[i].equals(selected)) pos = i;
        s.setSelection(pos); return s;
    }
    private GradientDrawable rounded(int fill, float radiusDp, float strokeDp, int strokeColor) {
        GradientDrawable d = new GradientDrawable(); d.setColor(fill); d.setCornerRadius(dp(radiusDp)); if (strokeDp > 0) d.setStroke(dp(strokeDp), strokeColor); return d;
    }
    private void divider(LinearLayout parent, int topDp) {
        View line = new View(this); line.setBackgroundColor(LINE); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)); p.topMargin = dp(topDp); parent.addView(line, p);
    }
    private LinearLayout.LayoutParams topMargin(int marginDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); p.topMargin = dp(marginDp); return p;
    }
    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private void setAnalyzeEnabled(boolean enabled) { analyzeButton.setEnabled(enabled); analyzeButton.setAlpha(enabled ? 1f : 0.45f); }

    private static final class ChartShot {
        final Uri uri; final Bitmap bitmap; String instrument = "AUTO"; String timeframe = "AUTO";
        ChartShot(Uri uri, Bitmap bitmap) { this.uri = uri; this.bitmap = bitmap; }
    }

    private static final class TradePlan {
        final String decision, setupId, setup, instrument, bias, dol;
        final double entry, stop, target, rr;
        final int confidence;
        final List<String> why, uncertainty;
        TradePlan(String decision, String setupId, String setup, String instrument, String bias, String dol, double entry, double stop, double target, double rr, int confidence, List<String> why, List<String> uncertainty) {
            this.decision = decision; this.setupId = setupId; this.setup = setup; this.instrument = instrument; this.bias = bias; this.dol = dol; this.entry = entry; this.stop = stop; this.target = target; this.rr = rr; this.confidence = confidence; this.why = why; this.uncertainty = uncertainty;
        }
        boolean actionable() { return decision.equals("LONG") || decision.equals("SHORT"); }
        static TradePlan waitPlan(String reason) {
            return new TradePlan("NO_TRADE", "NONE", "No validated setup", "UNKNOWN", "UNCLEAR", "UNCLEAR", Double.NaN, Double.NaN, Double.NaN, Double.NaN, 0, new ArrayList<>(java.util.Collections.singletonList(reason)), new ArrayList<>());
        }
        static TradePlan waitPlanWithContext(String setup, String instrument, String bias, String dol, int confidence, List<String> why, List<String> uncertainty) {
            return new TradePlan("NO_TRADE", "NONE", setup, instrument, bias, dol, Double.NaN, Double.NaN, Double.NaN, Double.NaN, confidence, why, uncertainty);
        }
    }

    private static final class SimpleItemListener implements android.widget.AdapterView.OnItemSelectedListener {
        interface Handler { void selected(int position); }
        private final Handler handler;
        SimpleItemListener(Handler handler) { this.handler = handler; }
        @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) { handler.selected(position); }
        @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
    }
}
