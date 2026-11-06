"""Markdown sent to HTML-rendered Odoo values is converted before the call goes out."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import odoo_mcp.server as server
from odoo_mcp.markdown_html import convert_markdown_payload, looks_like_html, markdown_to_html

TASK_FIELDS = {
    "name": {"type": "char"},
    "description": {"type": "html"},
    "child_ids": {"type": "one2many", "relation": "project.task"},
}


def _loader(model):
    return TASK_FIELDS


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("MCP_MARKDOWN_TO_HTML", raising=False)
    monkeypatch.delenv("MCP_READ_ONLY", raising=False)
    monkeypatch.delenv("MCP_WRITE_ALLOWLIST", raising=False)
    monkeypatch.delenv("MCP_VALIDATE_PAYLOADS", raising=False)
    monkeypatch.setenv("MCP_SAFETY_MODE", "permissive")


class TestConverter:
    def test_markdown_becomes_html(self):
        html = markdown_to_html("# Title\n\n- **one**\n- two")
        assert "<h1>Title</h1>" in html
        assert "<strong>one</strong>" in html
        assert "<ul>" in html

    def test_single_newline_is_a_line_break(self):
        assert "<br" in markdown_to_html("line one\nline two")

    def test_raw_angle_brackets_are_escaped(self):
        assert "&lt;script&gt;" in markdown_to_html("a <script> tag")

    @pytest.mark.parametrize("text", ["<p>hi</p>", "x<br/>y", "<div class='a'>z</div>"])
    def test_html_is_recognised(self, text):
        assert looks_like_html(text)

    @pytest.mark.parametrize("text", ["a < b and c > d", "**bold**", "plain"])
    def test_non_html_is_not_mistaken(self, text):
        assert not looks_like_html(text)


class TestPayload:
    def test_write_converts_only_html_fields(self):
        args, kwargs = convert_markdown_payload(
            "project.task", "write", [[7], {"name": "**n**", "description": "**d**"}], {}, _loader
        )
        assert args[1]["name"] == "**n**"
        assert args[1]["description"] == "<p><strong>d</strong></p>"

    def test_create_vals_list_in_kwargs(self):
        _, kwargs = convert_markdown_payload(
            "project.task", "create", [], {"vals_list": [{"name": "t", "description": "- a\n- b"}]}, _loader
        )
        assert kwargs["vals_list"][0]["description"].startswith("<ul>")

    def test_existing_html_is_untouched(self):
        args, _ = convert_markdown_payload("project.task", "write", [[7], {"description": "<p>x</p>"}], {}, _loader)
        assert args[1]["description"] == "<p>x</p>"

    def test_input_is_not_mutated(self):
        vals = {"description": "**d**"}
        convert_markdown_payload("project.task", "write", [[7], vals], {}, _loader)
        assert vals == {"description": "**d**"}

    def test_message_post_sets_body_is_html(self):
        _, kwargs = convert_markdown_payload("project.task", "message_post", [[7]], {"body": "*hi*"}, _loader)
        assert kwargs["body"] == "<p><em>hi</em></p>"
        assert kwargs["body_is_html"] is True

    def test_message_post_html_body_still_flagged(self):
        _, kwargs = convert_markdown_payload("project.task", "message_post", [[7]], {"body": "<p>x</p>"}, _loader)
        assert kwargs == {"body": "<p>x</p>", "body_is_html": True}

    def test_explicit_body_is_html_is_respected(self):
        _, kwargs = convert_markdown_payload(
            "project.task", "message_post", [[7]], {"body": "*hi*", "body_is_html": False}, _loader
        )
        assert kwargs["body_is_html"] is False

    def test_disabled_by_env(self, monkeypatch):
        monkeypatch.setenv("MCP_MARKDOWN_TO_HTML", "false")
        payload = ([[7]], {"body": "*hi*"})
        assert convert_markdown_payload("project.task", "message_post", *payload, _loader) == payload

    def test_schema_failure_sends_unchanged(self):
        def boom(model):
            raise RuntimeError("down")

        args, _ = convert_markdown_payload("project.task", "write", [[7], {"description": "**d**"}], {}, boom)
        assert args[1]["description"] == "**d**"

    def test_plain_one_liner_skips_the_schema(self):
        loader = MagicMock()
        convert_markdown_payload("project.task", "write", [[7], {"name": "Fix the printer"}], {}, loader)
        loader.assert_not_called()

    def test_reads_never_touch_the_schema(self):
        loader = MagicMock()
        convert_markdown_payload("project.task", "search_read", [[]], {"fields": ["name"]}, loader)
        loader.assert_not_called()


def _client():
    client = MagicMock()

    def execute(model, method, *args, **kwargs):
        if method == "fields_get":
            return TASK_FIELDS
        return True

    client.execute_method.side_effect = execute
    return client


def _sent(client, method):
    calls = [c for c in client.execute_method.call_args_list if c.args[1] == method]
    assert len(calls) == 1
    return calls[0]


class TestTools:
    def test_execute_method_sends_html(self):
        client = _client()
        with patch.object(server, "get_odoo_client", return_value=client):
            resp = server.execute_method(
                ctx=MagicMock(),
                model="project.task",
                method="message_post",
                args_json="[[7]]",
                kwargs_json=json.dumps({"body": "**done**", "message_type": "comment"}),
            )
        assert resp.success, resp.error
        call = _sent(client, "message_post")
        assert call.kwargs["body"] == "<p><strong>done</strong></p>"
        assert call.kwargs["body_is_html"] is True

    def test_batch_execute_sends_html(self):
        client = _client()
        ops = [{"model": "project.task", "method": "write", "args_json": '[[7], {"description": "# H"}]'}]
        with patch.object(server, "get_odoo_client", return_value=client):
            resp = asyncio.run(server.batch_execute(operations=ops, progress=AsyncMock()))
        assert resp.success, resp
        call = _sent(client, "write")
        assert call.args[3]["description"] == "<h1>H</h1>"
