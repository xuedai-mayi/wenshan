"""问山 Web 产品冒烟测试：真实 Chromium 渲染主页、模式菜单与知识图谱。"""

import math
import os
from pathlib import Path
from urllib.parse import quote
from playwright.sync_api import sync_playwright


ROOT = os.environ.get("WENSHAN_BASE_URL", "http://127.0.0.1:3080").rstrip("/")
OUTPUT = Path(__file__).resolve().parents[1] / "output"


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960}, device_scale_factor=1)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto(ROOT, wait_until="networkidle")
        assert page.title() == "问山：地理野外实习自成长智能助手"
        page.locator("#wenshan-graph-entry").wait_for(state="visible")
        home_text = page.locator("body").inner_text()
        assert "问山：地理野外实习自成长智能助手" in home_text
        assert "知识图谱" in home_text
        wallpaper = page.request.get(f"{ROOT}/wenshan/assets/valley.webp")
        assert wallpaper.ok
        assert wallpaper.headers["content-type"] == "image/webp"
        assert "valley.webp" in page.locator("#wenshan-product-style").inner_text()
        page.screenshot(path=str(OUTPUT / "wenshan-home.png"), full_page=True)

        preset_button = page.get_by_text("Standard mode", exact=True).first.or_(page.get_by_text("野外助教", exact=True).first)
        preset_button.wait_for(state="visible")
        preset_button.click()
        menu_text = page.locator("body").inner_text()
        page.screenshot(path=str(OUTPUT / "wenshan-modes.png"), full_page=True)
        assert "知识演化" in menu_text
        assert "野外助教" in menu_text
        assert "标准模式" not in menu_text
        assert "PTC 模式" not in menu_text
        assert "极简模式" not in menu_text
        assert "创造模式" not in menu_text
        page.get_by_text("知识演化", exact=True).first.click()
        page.locator("#wenshan-folder-entry").wait_for(state="visible")
        assert not page.locator("#wenshan-folder-panel").is_visible()
        page.locator("#wenshan-folder-entry").click()
        page.locator("#wenshan-folder-panel").wait_for(state="visible")
        assert "选择实习资料总文件夹" in page.locator("#wenshan-folder-panel").inner_text()

        page.goto(f"{ROOT}/wenshan/knowledge-graph", wait_until="networkidle")
        assert page.title() == "知识图谱｜问山：地理野外实习自成长智能助手"
        page.locator("#graph").wait_for(state="visible")
        force_graph = page.request.get(f"{ROOT}/wenshan/assets/force-graph.min.js")
        assert force_graph.ok
        assert force_graph.headers["content-type"].startswith("text/javascript")
        assert "cdn.jsdelivr.net" not in page.content()
        status = page.request.get(f"{ROOT}/wenshan/api/evolution/status")
        assert status.ok
        assert status.json()["graphNodes"] >= 252
        graph = page.request.get(f"{ROOT}/wenshan/api/evolution/graph")
        assert graph.ok
        graph_payload = graph.json()
        assert graph_payload["stats"]["graphLinks"] > 0
        assert len(graph.body()) < 220_000
        assert all("markdown" not in node and "content" not in node for node in graph_payload["nodes"])
        detail_node = next(node for node in graph_payload["nodes"] if node.get("hasContent"))
        detail = page.request.get(
            f"{ROOT}/wenshan/api/evolution/node?id={quote(str(detail_node['id']), safe='')}"
        )
        assert detail.ok
        assert detail.json().get("markdown") or detail.json().get("content")
        page.locator("#graph canvas").wait_for(state="visible")
        page.locator("#filters .filter").first.wait_for(state="visible")
        page.wait_for_function(
            "window.__wenshanGraph && window.__wenshanGraph.graphData().nodes.some(node => Number.isFinite(node.x))"
        )
        page.wait_for_timeout(1800)
        canvas_target = page.evaluate(
            """() => {
              const graph = window.__wenshanGraph
              const candidates = graph.graphData().nodes
                .filter(node => node.hasContent)
                .map(node => ({ node, point: graph.graph2ScreenCoords(node.x, node.y) }))
                .filter(item => item.point.x > 340 && item.point.x < 900 && item.point.y > 100 && item.point.y < 850)
              const item = candidates[0]
              return item ? { x: item.point.x, y: item.point.y, id: item.node.id, title: item.node.title } : null
            }"""
        )
        assert canvas_target is not None
        view_before_click = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        assert math.isfinite(view_before_click["zoom"]) and view_before_click["zoom"] > 0
        page.mouse.click(canvas_target["x"], canvas_target["y"])
        page.locator("#inspector.show").wait_for(state="visible")
        assert page.locator("#detail-title").inner_text() == canvas_target["title"]
        page.wait_for_function("document.querySelector('#note-content').innerText.trim().length > 20")
        assert len(page.locator("#note-content").inner_text()) > 20
        view_after_click = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        assert abs(view_after_click["zoom"] - view_before_click["zoom"]) < 0.02
        assert abs(view_after_click["center"]["x"] - view_before_click["center"]["x"]) < 2
        assert abs(view_after_click["center"]["y"] - view_before_click["center"]["y"]) < 2
        page.locator("#detail-focus").click()
        view_after_focus = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        assert view_after_focus["zoom"] >= 1.07
        assert (
            abs(view_after_focus["center"]["x"] - view_after_click["center"]["x"]) > 2
            or abs(view_after_focus["center"]["y"] - view_after_click["center"]["y"]) > 2
            or abs(view_after_focus["zoom"] - view_after_click["zoom"]) > 0.02
        )

        drag_target = page.evaluate(
            """() => {
              const graph = window.__wenshanGraph
              const node = graph.graphData().nodes.find(item => item.title === '朴树')
              if (!node) return null
              graph.centerAt(node.x, node.y, 0)
              graph.zoom(1.2)
              const point = graph.graph2ScreenCoords(node.x, node.y)
              const clearance = Math.min(...graph.graphData().nodes
                .filter(other => other.id !== node.id)
                .map(other => {
                  const otherPoint = graph.graph2ScreenCoords(other.x, other.y)
                  return Math.hypot(otherPoint.x - point.x, otherPoint.y - point.y)
                }))
              return {
                id: node.id,
                x: point.x,
                y: point.y,
                nodeX: node.x,
                nodeY: node.y,
                clearance,
              }
            }"""
        )
        assert drag_target is not None and drag_target["clearance"] > 25
        page.mouse.move(drag_target["x"], drag_target["y"], steps=6)
        page.wait_for_function("id => window.__wenshanHoveredNodeId === id", arg=drag_target["id"])
        hovered_id = page.evaluate("window.__wenshanHoveredNodeId")
        assert hovered_id
        dragged_before = page.evaluate(
            """id => {
              const node = window.__wenshanGraph.graphData().nodes.find(item => item.id === id)
              return { x: node.x, y: node.y }
            }""",
            hovered_id,
        )
        page.wait_for_timeout(100)
        page.mouse.down()
        page.wait_for_timeout(40)
        for step in range(1, 11):
            page.mouse.move(drag_target["x"] + step * 8, drag_target["y"] + step * 4)
            page.wait_for_timeout(18)
        page.mouse.up()
        page.wait_for_timeout(180)
        dragged = page.evaluate(
            """id => {
              const node = window.__wenshanGraph.graphData().nodes.find(item => item.id === id)
              return { x: node.x, y: node.y, fx: node.fx, fy: node.fy }
            }""",
            hovered_id,
        )
        assert abs(dragged["x"] - dragged_before["x"]) > 5
        assert isinstance(dragged["fx"], (int, float)) and isinstance(dragged["fy"], (int, float))
        double_click_target = page.evaluate(
            """id => {
              const graph = window.__wenshanGraph
              const node = graph.graphData().nodes.find(item => item.id === id)
              const point = graph.graph2ScreenCoords(node.x, node.y)
              return { x: point.x, y: point.y, title: node.title }
            }""",
            hovered_id,
        )
        view_before_double_click = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        page.mouse.dblclick(double_click_target["x"], double_click_target["y"], delay=80)
        assert page.locator("#detail-title").inner_text() == double_click_target["title"]
        view_after_double_click = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        assert (
            abs(view_after_double_click["center"]["x"] - view_before_double_click["center"]["x"]) > 2
            or abs(view_after_double_click["center"]["y"] - view_before_double_click["center"]["y"]) > 2
            or abs(view_after_double_click["zoom"] - view_before_double_click["zoom"]) > 0.02
        )
        search_query = page.locator("#search")
        search_query.fill("庐山")
        first_result = page.locator("#results .search-result").first
        first_result.wait_for(state="visible")
        matched_title = first_result.locator("span").inner_text()
        first_result.click()
        page.locator("#inspector").wait_for(state="visible")
        assert page.locator("#detail-title").inner_text() == matched_title
        assert page.locator("#note-content .wiki-link").count() > 0
        first_filter = page.locator("#filters .filter").first
        view_before_filter = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        first_filter.click()
        assert first_filter.get_attribute("aria-pressed") == "false"
        view_after_filter = page.evaluate(
            "() => ({ zoom: window.__wenshanGraph.zoom(), center: window.__wenshanGraph.centerAt() })"
        )
        assert abs(view_after_filter["zoom"] - view_before_filter["zoom"]) < 0.02
        assert abs(view_after_filter["center"]["x"] - view_before_filter["center"]["x"]) < 2
        assert abs(view_after_filter["center"]["y"] - view_before_filter["center"]["y"]) < 2
        first_filter.click()
        assert first_filter.get_attribute("aria-pressed") == "true"
        zoom_before_button = page.evaluate("window.__wenshanGraph.zoom()")
        page.locator("#zoom-in").click()
        zoom_after_button = page.evaluate("window.__wenshanGraph.zoom()")
        assert zoom_after_button > zoom_before_button
        page.locator("#fit").click()
        assert math.isfinite(page.evaluate("window.__wenshanGraph.zoom()"))
        page.screenshot(path=str(OUTPUT / "wenshan-graph-selected.png"), full_page=True)
        page.screenshot(path=str(OUTPUT / "wenshan-graph.png"), full_page=True)

        page.set_viewport_size({"width": 390, "height": 844})
        page.reload(wait_until="networkidle")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.wait_for_function(
            "window.__wenshanGraph && window.__wenshanGraph.graphData().nodes.some(node => Number.isFinite(node.x))"
        )
        page.wait_for_timeout(1800)
        mobile_target = page.evaluate(
            """() => {
              const graph = window.__wenshanGraph
              const candidates = graph.graphData().nodes
                .filter(node => node.hasContent)
                .map(node => ({ node, point: graph.graph2ScreenCoords(node.x, node.y) }))
                .filter(item => item.point.x > 18 && item.point.x < 372 && item.point.y > 135 && item.point.y < 700)
              const item = candidates[0]
              return item ? { x: item.point.x, y: item.point.y, title: item.node.title } : null
            }"""
        )
        assert mobile_target is not None
        page.mouse.click(mobile_target["x"], mobile_target["y"])
        page.locator("#inspector.show").wait_for(state="visible")
        assert page.locator("#detail-title").inner_text() == mobile_target["title"]
        page.wait_for_function("document.querySelector('#note-content').innerText.trim().length > 20")
        assert len(page.locator("#note-content").inner_text()) > 20
        page.wait_for_timeout(700)
        page.screenshot(path=str(OUTPUT / "wenshan-graph-mobile.png"), full_page=True)

        dark_page = browser.new_page(
            viewport={"width": 1440, "height": 960},
            device_scale_factor=1,
            color_scheme="dark",
            locale="zh-CN",
        )
        dark_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        dark_page.on("pageerror", lambda error: page_errors.append(str(error)))
        dark_page.goto(ROOT, wait_until="networkidle")
        assert dark_page.locator("body").get_attribute("data-ds-dark-theme") is not None
        assert "linear-gradient" in dark_page.locator("[data-composer-card]").evaluate(
            "element => getComputedStyle(element).backgroundImage"
        )
        assert dark_page.locator('[class*="_headlineText"]').evaluate(
            "element => getComputedStyle(element).fontSize"
        ) == "31px"
        dark_page.screenshot(path=str(OUTPUT / "wenshan-home-dark.png"), full_page=True)
        dark_page.close()
        browser.close()

    if console_errors:
        raise AssertionError("浏览器控制台错误：\n" + "\n".join(console_errors))
    if page_errors:
        raise AssertionError("浏览器页面错误：\n" + "\n".join(page_errors))
    print("Web smoke test passed")


if __name__ == "__main__":
    main()
