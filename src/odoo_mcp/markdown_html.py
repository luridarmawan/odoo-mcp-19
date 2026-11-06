"""Markdown → HTML for the text Odoo renders as HTML.

Agents write Markdown, but Odoo stores ``html`` fields (``project.task.description``,
``mail.message.body``, ``sale.order.note``…) and chatter bodies as HTML. Sent as-is,
Markdown shows up as one run-on line with literal ``**`` and ``#``; and
``message_post`` escapes any ``body`` sent without ``body_is_html=True``, so even
real HTML shows its tags.

``convert_markdown_payload`` rewrites, just before a call is sent:

* every string value of an ``html`` field in the vals of ``create`` / ``write``
  (field types from the cached compact ``fields_get``);
* the ``body`` of ``message_post`` (and sets ``body_is_html=True`` unless the
  caller set it) and the ``note`` of ``activity_schedule``.

A value that already contains HTML tags is left alone, so callers that send HTML
keep working. ``MCP_MARKDOWN_TO_HTML=false`` turns the conversion off. It runs
after the confirmation gate, on a fresh copy of the payload, so the gate digest
is unchanged: the conversion is deterministic.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Callable

from markdown_it import MarkdownIt

logger = logging.getLogger(__name__)

_ENV = "MCP_MARKDOWN_TO_HTML"
_FALSY = frozenset({"0", "false", "no", "off"})

# Tags Odoo's own editor produces; any of them means "this is HTML already".
_HTML_TAG = re.compile(
    r"</?(p|br|div|span|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|strong|em|b|i|u|s|a|"
    r"pre|code|blockquote|img|hr)\b[^<>]*>",
    re.IGNORECASE,
)

# Anything Markdown would render differently from the bare text. A one-line value
# without these renders the same either way, so it costs no fields_get round-trip.
_MARKDOWN_HINT = re.compile(r"\n|[*_`#>\[~|]|^\s*(?:[-+]|\d+[.)])\s", re.MULTILINE)

# html=False: a stray '<' in Markdown text is escaped, never passed through as markup.
# breaks=True: a single newline is a line break, as people expect from a comment box.
_MD = MarkdownIt("commonmark", {"html": False, "breaks": True}).enable(["table", "strikethrough"])

# Methods whose keyword argument is rendered as HTML by Odoo.
_METHOD_HTML_KWARGS: dict[str, str] = {
    "message_post": "body",
    "activity_schedule": "note",
}

# Where create / write carry their vals: (positional index, keyword name).
_VALS_LOCATION: dict[str, tuple[int, str]] = {
    "create": (0, "vals_list"),
    "write": (1, "vals"),
}


def is_enabled() -> bool:
    return os.environ.get(_ENV, "true").strip().lower() not in _FALSY


def looks_like_html(text: str) -> bool:
    return bool(_HTML_TAG.search(text))


def markdown_to_html(text: str) -> str:
    return _MD.render(text).strip()


def _convert(value: Any) -> Any:
    if isinstance(value, str) and value.strip() and not looks_like_html(value):
        return markdown_to_html(value)
    return value


def _convert_vals(vals: Any, html_fields: frozenset[str]) -> Any:
    if isinstance(vals, dict):
        return {k: (_convert(v) if k in html_fields else v) for k, v in vals.items()}
    if isinstance(vals, list):
        return [_convert_vals(item, html_fields) if isinstance(item, dict) else item for item in vals]
    return vals


def _has_markdown(vals: Any) -> bool:
    if isinstance(vals, dict):
        dicts = [vals]
    elif isinstance(vals, list):
        dicts = [item for item in vals if isinstance(item, dict)]
    else:
        return False
    return any(isinstance(v, str) and _MARKDOWN_HINT.search(v) for d in dicts for v in d.values())


def _html_fields(model: str, fields_loader: Callable[[str], dict]) -> frozenset[str]:
    try:
        fields = fields_loader(model) or {}
    except Exception as exc:  # never block a write over a formatting nicety
        logger.warning("Markdown conversion skipped for %s: fields_get failed: %s", model, exc)
        return frozenset()
    return frozenset(name for name, spec in fields.items() if isinstance(spec, dict) and spec.get("type") == "html")


def convert_markdown_payload(
    model: str,
    method: str,
    args: list,
    kwargs: dict,
    fields_loader: Callable[[str], dict],
) -> tuple[list, dict]:
    """Return ``(args, kwargs)`` with Markdown in HTML-rendered values turned into HTML."""
    if not is_enabled():
        return args, kwargs

    key = _METHOD_HTML_KWARGS.get(method)
    if key and isinstance(kwargs.get(key), str):
        kwargs = dict(kwargs)
        kwargs[key] = _convert(kwargs[key])
        if method == "message_post" and "body_is_html" not in kwargs:
            kwargs["body_is_html"] = True
        return args, kwargs

    location = _VALS_LOCATION.get(method)
    if not location:
        return args, kwargs
    index, name = location
    in_args = len(args) > index
    vals = args[index] if in_args else kwargs.get(name)
    if not _has_markdown(vals):
        return args, kwargs

    html_fields = _html_fields(model, fields_loader)
    if not html_fields:
        return args, kwargs
    converted = _convert_vals(vals, html_fields)
    if in_args:
        args = list(args)
        args[index] = converted
    else:
        kwargs = dict(kwargs)
        kwargs[name] = converted
    return args, kwargs
