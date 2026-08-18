from datetime import date

import og_card


class FakeD1:
    def __init__(self, bottles, tracks):
        self.bottles = bottles
        self.tracks = tracks

    def query(self, sql, params=None):
        if "FROM bottles" in sql:
            return self.bottles
        if "track_points" in sql:
            return self.tracks.get(params[0], [])
        return []


class FakeS3:
    def __init__(self):
        self.puts = []

    def put_object(self, **kw):
        self.puts.append(kw)


def _bottle(id, pid, status="drifting", dist=100, created="2026-08-01", lang="en"):
    return {
        "id": id,
        "public_id": pid,
        "status": status,
        "distance_km": dist,
        "created_at": created,
        "lang": lang,
    }


def test_days_since():
    assert og_card.days_since("2026-08-01T00:00:00Z", date(2026, 8, 18)) == 17


def test_uploads_each_bottle_with_correct_key():
    bottles = [
        _bottle(1, "aaaaaaaaaaaa", lang="zh"),
        _bottle(2, "bbbbbbbbbbbb", "beached"),
    ]
    tracks = {
        1: [{"lat": 0, "lon": 0}, {"lat": 1, "lon": 1}],
        2: [{"lat": 5, "lon": 5}],
    }
    s3 = FakeS3()
    n = og_card.render_and_upload_all(
        FakeD1(bottles, tracks), s3, "bk", None, date(2026, 8, 18)
    )
    assert n == 2
    assert sorted(k["Key"] for k in s3.puts) == [
        "og/aaaaaaaaaaaa.png",
        "og/bbbbbbbbbbbb.png",
    ]
    assert all(k["ContentType"] == "image/png" for k in s3.puts)
    assert all(k["Bucket"] == "bk" for k in s3.puts)


def test_one_bottle_failure_does_not_abort_batch():
    bottles = [
        _bottle(1, "good11111111"),
        _bottle(2, "bad222222222", created="NOT-A-DATE"),
    ]
    tracks = {1: [{"lat": 0, "lon": 0}], 2: [{"lat": 0, "lon": 0}]}
    s3 = FakeS3()
    n = og_card.render_and_upload_all(
        FakeD1(bottles, tracks), s3, "bk", None, date(2026, 8, 18)
    )
    assert n == 1
    assert [k["Key"] for k in s3.puts] == ["og/good11111111.png"]
