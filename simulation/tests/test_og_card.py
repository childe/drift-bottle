import io

from PIL import Image

from og_card import (
    W,
    H,
    unwrap_lons,
    compute_view,
    to_pixel,
    stat_line,
    brand_text,
    render_card,
    render_default_card,
)


def test_stat_line_zh_drifting():
    assert stat_line(3200.4, 48, "drifting", "zh") == "漂了 3,200 公里 · 48 天 · 漂流中"


def test_stat_line_en_beached_singular_day():
    assert stat_line(1000, 1, "beached", "en") == "Drifted 1,000 km · 1 day · Beached"


def test_stat_line_en_plural_days():
    assert (
        stat_line(2500, 12, "drifting", "en") == "Drifted 2,500 km · 12 days · Drifting"
    )


def test_brand_text():
    assert brand_text("zh") == "漂流瓶"
    assert brand_text("en") == "Drift Bottle"


def test_unwrap_lons_crosses_antimeridian():
    assert unwrap_lons([179.0, -179.0]) == [179.0, 181.0]


def test_compute_view_non_degenerate_for_single_point():
    lon_min, lon_max, lat_min, lat_max = compute_view([10.0, 10.0], [20.0, 20.0])
    assert lon_max > lon_min and lat_max > lat_min


def test_to_pixel_top_left_and_bottom_right():
    view = (0.0, 10.0, 0.0, 10.0)  # lon_min,lon_max,lat_min,lat_max
    x0, y0 = to_pixel(0.0, 10.0, view)  # 左上
    x1, y1 = to_pixel(10.0, 0.0, view)  # 右下
    assert round(x0) == 0 and round(y0) == 0
    assert round(x1) == W and round(y1) == H


def test_render_card_returns_1200x630_png():
    png = render_card([(0.0, 0.0), (1.0, 1.0), (2.0, 3.0)], 3200, 48, "drifting", "zh")
    im = Image.open(io.BytesIO(png))
    assert im.format == "PNG" and im.size == (W, H)


def test_render_card_single_point():
    png = render_card([(10.0, 20.0)], 0, 0, "drifting", "en")
    assert Image.open(io.BytesIO(png)).size == (W, H)


def test_render_card_empty_track():
    png = render_card([], 0, 0, "beached", "en")
    assert Image.open(io.BytesIO(png)).size == (W, H)


def test_render_default_card():
    im = Image.open(io.BytesIO(render_default_card()))
    assert im.format == "PNG" and im.size == (W, H)
