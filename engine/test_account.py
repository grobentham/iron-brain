"""Account-fit tests: sizing respects the caps, and the evaluation simulator behaves sensibly."""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import account as A  # noqa: E402


def test_sizing():
    assert A.contracts(500, 100, 2) == 2            # $200 per micro at a 100-point NQ stop
    assert A.contracts(10000, 10, 2) == 40           # never above the 40-micro cap
    assert A.contracts(100, 200, 2) == 0             # too small for one micro
    assert A.contracts(500, 0, 2) == 0


def test_evaluation():
    rnd = random.Random(3)
    n = 500
    stops = [60.0] * n
    edge = [rnd.gauss(12, 60) for _ in range(n)]     # about +$24 a day per micro on average
    flat = [rnd.gauss(0, 60) for _ in range(n)]
    e = A.evaluate(edge, stops, 2, 500, runs=600)
    z = A.evaluate(flat, stops, 2, 500, runs=600)
    assert e["micros"] == 4 and 0 <= e["pass"] <= 1 and abs(e["pass"] + e["breach"] + e["neither"] - 1) < 0.01
    assert e["pass"] > e["noEdge"]["pass"] + 0.1, "a real edge passes clearly more often than luck"
    assert abs(z["pass"] - z["noEdge"]["pass"]) < 0.1, "no edge passes about as often as luck"
    wide = A.evaluate(edge, [900.0] * n, 2, 500, runs=50)
    assert wide["unsizeable"] and wide["microRiskUsd"] == 1800


if __name__ == "__main__":
    test_sizing()
    test_evaluation()
    print("account tests passed")
