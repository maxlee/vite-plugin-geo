/**
 * SEO generator module for sitemap.xml / llms.txt / robots.txt
 */

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, basename, resolve } from 'path';
import { parse, serialize } from 'parse5';
import TurndownService from 'turndown';
import { collectAuditFacts } from './geoAudit.js';

const DEFAULT_STRIP_PATH_PREFIXES = ['src/pages/'];
export const DEFAULT_EXCLUDE_PATTERNS = ['404.html', '500.html'];
const MARKDOWN_STRIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  'nav',
]);
const MARKDOWN_BODY_CHROME_TAGS = new Set(['nav', 'aside', 'footer']);
const MARKDOWN_BODY_CHROME_ROLES = new Set(['navigation', 'complementary', 'contentinfo']);
const HEADING_TAG_NAMES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_LINK_DESCENDANTS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'DIV', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER',
  'FIGURE', 'FIGCAPTION', 'TABLE', 'PRE', 'HR',
  'ASIDE', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD',
]);
const SPACING_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'audio', 'blockquote', 'body', 'br', 'canvas',
  'caption', 'center', 'dd', 'details', 'dir', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'frameset', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'isindex', 'li', 'main', 'menu',
  'nav', 'noframes', 'noscript', 'ol', 'output', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'wbr',
]);
const CLOSING_NO_SPACE_BEFORE = new Set([
  ',', '.', ';', ':', '!', '?', ')', ']', '}', '”', '’', '…',
  '、', '。', '，', '；', '：', '！', '？', '）', '】', '》', '」', '』',
  '%', '°', '/', '-', '+',
]);
const OPENING_NO_SPACE_AFTER = new Set([
  '(', '[', '{', '“', '‘', '/', '-', '+', '$', '#', '@',
  '（', '【', '《', '「', '『',
]);
const ABSOLUTE_URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const LEADING_H1_PATTERN = /^#(?!#)\s+(.+?)(?:\s+#+)?\s*$/;
const SITEMAP_MAX_URLS = 50000;
const SITEMAP_MAX_BYTES = 52_428_800;

/**
 * Compare strings deterministically by UTF-16 code units (locale-independent).
 * @param {string} left - First string
 * @param {string} right - Second string
 * @returns {-1|0|1} Comparison result
 */
export function compareCodeUnits(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Return true when targetPath resolves inside (or equal to) baseDir.
 * @param {string} baseDir - Directory boundary
 * @param {string} targetPath - Candidate path
 * @returns {boolean} True if contained within baseDir
 */
export function isWithinDir(baseDir, targetPath) {
  if (typeof baseDir !== 'string' || typeof targetPath !== 'string' || !baseDir || !targetPath) {
    return false;
  }
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Strip ASCII control characters from output text safely.
 * @param {unknown} value - Candidate value
 * @param {{preserveNewlines?: boolean}} [options={}] - Sanitization options
 * @returns {string} Sanitized text
 */
export function sanitizeControlChars(value, { preserveNewlines = false } = {}) {
  const str = String(value ?? '');
  if (preserveNewlines) {
    return str
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }
  return str
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * Assert that a file path is a safe relative path that does not escape its base directory.
 * @param {unknown} filePath - Candidate relative path
 * @param {string} [label='path'] - Error context label
 * @returns {string} Canonical normalized POSIX relative path
 */
export function assertSafeRelativePath(filePath, label = 'path') {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`Invalid ${label}: expected a non-empty relative path.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new Error(`Invalid ${label}: "${filePath}" contains control characters.`);
  }
  const posix = filePath.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[a-zA-Z]:(?:\/|$)/.test(posix)) {
    throw new Error(`Invalid ${label}: "${filePath}" must be a relative path.`);
  }
  const segments = posix.split('/').filter((segment) => segment && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`Invalid ${label}: "${filePath}" escapes the output directory.`);
  }
  return segments.join('/');
}

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});

turndownService.remove([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  'nav',
]);

const tableCellTextMap = new WeakMap();
const tableCaptionMap = new WeakMap();

function formatTableCellText(content) {
  return String(content || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/(\\*)\|/g, (match, slashes) => (
      slashes.length % 2 === 1 ? match : `${slashes}\\|`
    ));
}

function getTableRowCells(trNode) {
  return Array.from(trNode.childNodes || [])
    .filter((child) => child.nodeType === 1 && (child.nodeName === 'TH' || child.nodeName === 'TD'))
    .map((cellNode) => tableCellTextMap.get(cellNode) ?? formatTableCellText(cellNode.textContent));
}

function collectTableRowGroups(tableNode) {
  const theadRows = [];
  const bodyRows = [];
  const tfootRows = [];
  const extractRows = (container) => Array.from(container.childNodes || [])
    .filter((child) => child.nodeType === 1 && child.nodeName === 'TR');

  for (const child of Array.from(tableNode.childNodes || [])) {
    if (child.nodeType !== 1) continue;
    if (child.nodeName === 'THEAD') {
      theadRows.push(...extractRows(child));
    } else if (child.nodeName === 'TBODY') {
      bodyRows.push(...extractRows(child));
    } else if (child.nodeName === 'TFOOT') {
      tfootRows.push(...extractRows(child));
    } else if (child.nodeName === 'TR') {
      bodyRows.push(child);
    }
  }
  return { theadRows, bodyRows, tfootRows };
}

turndownService.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement(content, node) {
    const cellText = formatTableCellText(content);
    tableCellTextMap.set(node, cellText);
    return `| ${cellText} `;
  },
});

turndownService.addRule('tableRow', {
  filter: 'tr',
  replacement(_content, node) {
    const cells = getTableRowCells(node);
    if (cells.length === 0) {
      return '';
    }
    return `| ${cells.join(' | ')} |\n`;
  },
});

turndownService.addRule('tableSection', {
  filter: ['thead', 'tbody', 'tfoot'],
  replacement(content) {
    return content;
  },
});

turndownService.addRule('tableCaption', {
  filter: 'caption',
  replacement(content, node) {
    const trimmed = content.replace(/\r?\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (trimmed) {
      tableCaptionMap.set(node, trimmed);
    }
    return '';
  },
});

turndownService.addRule('table', {
  filter: 'table',
  replacement(_content, node) {
    const { theadRows, bodyRows, tfootRows } = collectTableRowGroups(node);
    const rowCells = [...theadRows, ...bodyRows, ...tfootRows]
      .map((trNode) => getTableRowCells(trNode))
      .filter((cells) => cells.length > 0);

    if (rowCells.length === 0) {
      return '';
    }

    const colCount = Math.max(...rowCells.map((cells) => cells.length), 1);
    const formatRow = (cells) => {
      const padded = cells.length < colCount
        ? [...cells, ...Array(colCount - cells.length).fill('')]
        : cells;
      return `| ${padded.join(' | ')} |`;
    };

    const headerRow = rowCells[0];
    const separatorRow = Array(colCount).fill('---');
    const dataRows = rowCells.slice(1);
    const tableLines = [
      formatRow(headerRow),
      formatRow(separatorRow),
      ...dataRows.map(formatRow),
    ];

    const captionNode = Array.from(node.childNodes || [])
      .find((child) => child.nodeType === 1 && child.nodeName === 'CAPTION');
    const caption = captionNode ? (tableCaptionMap.get(captionNode) || '') : '';
    const captionPrefix = caption ? `${caption}\n\n` : '';

    return `\n\n${captionPrefix}${tableLines.join('\n')}\n\n`;
  },
});

turndownService.addRule('summary', {
  filter: 'summary',
  replacement(content) {
    const text = content.replace(/\r?\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
    if (!text) {
      return '';
    }
    if (/^#{1,6}\s+/.test(text) || /^\*\*(?:(?!\*\*).)+\*\*$/.test(text)) {
      return `\n\n${text}\n\n`;
    }
    return `\n\n**${text.replace(/(?<!\\)\*\*/g, '')}**\n\n`;
  },
});

turndownService.addRule('details', {
  filter: 'details',
  replacement(content) {
    const trimmed = content.replace(/^\n+|\n+$/g, '');
    return trimmed ? `\n\n${trimmed}\n\n` : '';
  },
});

function forEachMarkdownLine(markdownText, onLine) {
  const lines = String(markdownText || '').split('\n');
  let activeFence = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = !activeFence
      ? trimmed.match(/^(`{3,})[^`]*$|^((?:~{3,}))/)
      : null;
    if (!activeFence && fenceMatch) {
      const fence = fenceMatch[1] || fenceMatch[2];
      activeFence = fence[0].repeat(fence.length);
      onLine(line, true);
      continue;
    }
    if (activeFence) {
      onLine(line, true);
      const closePattern = new RegExp(`^\\s*${activeFence[0]}{${activeFence.length},}\\s*$`);
      if (closePattern.test(line)) {
        activeFence = null;
      }
      continue;
    }
    onLine(line, false);
  }
}

function hasBlockDescendant(node) {
  if (!node || !Array.isArray(node.childNodes)) {
    return false;
  }
  for (const child of node.childNodes) {
    const tag = child?.tagName || (child?.nodeType === 1 ? child.nodeName : '');
    if (typeof tag === 'string' && tag) {
      if (BLOCK_LINK_DESCENDANTS.has(tag.toUpperCase()) || hasBlockDescendant(child)) {
        return true;
      }
    }
  }
  return false;
}

function escapeTurndownLinkDestination(destination) {
  const escaped = String(destination || '').replace(/([<>()])/g, '\\$1');
  return escaped.indexOf(' ') >= 0 ? `<${escaped}>` : escaped;
}

function escapeTurndownLinkTitle(title) {
  const cleaned = title ? String(title).replace(/(\n+\s*)+/g, '\n') : '';
  return cleaned ? ` "${cleaned.replace(/"/g, '\\"')}"` : '';
}

function splitMarkdownBlocks(markdownText) {
  const blocks = [];
  let current = [];

  forEachMarkdownLine(String(markdownText || '').trim(), (line, inFence) => {
    if (!inFence && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      return;
    }
    current.push(line);
  });

  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }
  return blocks;
}

function formatBlockAnchorContent(content, href, titlePart) {
  const blocks = splitMarkdownBlocks(content);
  if (blocks.length === 0) {
    return '';
  }

  const makeLink = (label) => `[${label}](${href}${titlePart})`;

  const headingIndex = blocks.findIndex((block) => !block.includes('\n') && /^(#{1,6})\s+(.+)$/.test(block));
  if (headingIndex !== -1) {
    const match = blocks[headingIndex].match(/^(#{1,6})\s+(.+)$/);
    const headingText = match[2].trim();
    if (!headingText.includes('](')) {
      blocks[headingIndex] = `${match[1]} ${makeLink(headingText)}`;
    }
    return `\n\n${blocks.join('\n\n')}\n\n`;
  }

  const isNonTextBlock = (block) => (
    /^(?:!\[[^\]]*\]\([^)]*\)\s*)+$/.test(block)
    || /^(?:\*{3,}|-{3,}|_{3,})$/.test(block)
    || /^(?:`{3,}|~{3,})/.test(block.trimStart())
  );
  const textIndex = blocks.findIndex((block) => !isNonTextBlock(block));

  if (textIndex === -1) {
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(blocks[0])) {
      blocks[0] = makeLink(blocks[0]);
      return `\n\n${blocks.join('\n\n')}\n\n`;
    }
    return `\n\n${[makeLink(href), ...blocks].join('\n\n')}\n\n`;
  }

  const targetBlock = blocks[textIndex];
  const blockLines = targetBlock.split('\n');
  const formatLinePrefix = (line) => {
    const listMatch = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)(.+)$/);
    if (listMatch) {
      return `${listMatch[1]}${makeLink(listMatch[2].trim())}`;
    }
    const quoteMatch = line.match(/^(\s*>\s+)(.+)$/);
    if (quoteMatch) {
      return `${quoteMatch[1]}${makeLink(quoteMatch[2].trim())}`;
    }
    return null;
  };

  if (blockLines.length === 1) {
    if (/^\|.*\|$/.test(targetBlock.trim())) {
      blocks.splice(textIndex, 0, makeLink(href));
    } else {
      blocks[textIndex] = formatLinePrefix(targetBlock) || makeLink(targetBlock.trim());
    }
  } else {
    const firstLine = blockLines[0].trim();
    const rest = blockLines.slice(1).join('\n').trim();
    const prefixed = formatLinePrefix(blockLines[0]);
    if (prefixed) {
      blocks[textIndex] = `${prefixed}\n${rest}`;
    } else if (/^\|.*\|$/.test(firstLine)) {
      blocks.splice(textIndex, 0, makeLink(href));
    } else {
      blocks[textIndex] = `${makeLink(firstLine)}\n\n${rest}`;
    }
  }

  return `\n\n${blocks.join('\n\n')}\n\n`;
}

turndownService.addRule('blockOrMultilineLink', {
  filter(node, options) {
    return options.linkStyle === 'inlined' && node.nodeName === 'A' && Boolean(node.getAttribute('href'));
  },
  replacement(content, node) {
    const href = escapeTurndownLinkDestination(node.getAttribute('href'));
    const titlePart = escapeTurndownLinkTitle(node.getAttribute('title'));

    if (hasBlockDescendant(node)) {
      return formatBlockAnchorContent(content, href, titlePart);
    }

    if (content.includes('\n')) {
      if (/\n\s*\n/.test(content)) {
        return formatBlockAnchorContent(content, href, titlePart);
      }
      const collapsed = content.replace(/\s*\n+\s*/g, ' ').trim();
      return `[${collapsed}](${href}${titlePart})`;
    }

    return `[${content}](${href}${titlePart})`;
  },
});

/**
 * Find the first element node by tag name in parse5 AST.
 * @param {object} node - parse5 AST node
 * @param {string} tagName - HTML tag name
 * @returns {object|null} Matched node
 */
function findFirstNodeByTagName(node, tagName) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.tagName === tagName) {
    return node;
  }

  if (!Array.isArray(node.childNodes)) {
    return null;
  }

  for (const childNode of node.childNodes) {
    const matchedNode = findFirstNodeByTagName(childNode, tagName);
    if (matchedNode) {
      return matchedNode;
    }
  }

  return null;
}

function findFirstNodeByRole(node, role) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  const roles = getAttribute(node, 'role').toLowerCase().split(/\s+/).filter(Boolean);
  if (roles.includes(role)) {
    return node;
  }

  if (!Array.isArray(node.childNodes)) {
    return null;
  }

  for (const childNode of node.childNodes) {
    const matchedNode = findFirstNodeByRole(childNode, role);
    if (matchedNode) {
      return matchedNode;
    }
  }

  return null;
}

function containsHeadingNode(node) {
  if (!node || typeof node !== 'object') {
    return false;
  }

  if (HEADING_TAG_NAMES.has(node.tagName)) {
    return true;
  }

  return Array.isArray(node.childNodes) && node.childNodes.some((childNode) => (
    containsHeadingNode(childNode)
  ));
}

/**
 * Choose the element that represents the page's readable content.
 * `<main>` is authoritative, a single `<article>` is the next best signal,
 * and `<body>` is the fallback for pages without semantic containers.
 */
function selectMarkdownContentRoot(documentAst) {
  const mainNode = findFirstNodeByTagName(documentAst, 'main')
    || findFirstNodeByRole(documentAst, 'main');
  if (mainNode) {
    return { node: mainNode, bodyFallback: false };
  }

  const articleNodes = findNodesByTagName(documentAst, 'article');
  if (articleNodes.length === 1) {
    return { node: articleNodes[0], bodyFallback: false };
  }

  const bodyNode = findFirstNodeByTagName(documentAst, 'body');
  return { node: bodyNode || documentAst, bodyFallback: Boolean(bodyNode) };
}

function shouldKeepBodyChild(childNode) {
  if (!childNode || typeof childNode !== 'object') {
    return true;
  }

  if (MARKDOWN_BODY_CHROME_TAGS.has(childNode.tagName)) {
    return false;
  }

  const roles = getAttribute(childNode, 'role').toLowerCase().split(/\s+/).filter(Boolean);
  if (roles.some((role) => MARKDOWN_BODY_CHROME_ROLES.has(role))) {
    return false;
  }

  if (childNode.tagName === 'header' || roles.includes('banner')) {
    return containsHeadingNode(childNode);
  }

  return true;
}

/**
 * Remove site chrome from a `<body>` fallback while keeping article-internal
 * headers and footers intact.
 */
function stripBodyChromeNodes(node) {
  if (!node || !Array.isArray(node.childNodes)) {
    return;
  }

  node.childNodes = node.childNodes.filter((childNode) => shouldKeepBodyChild(childNode));
  node.childNodes.forEach((childNode) => {
    if (childNode?.tagName === 'main' || childNode?.tagName === 'article') {
      return;
    }
    stripBodyChromeNodes(childNode);
  });
}

function getNodeText(node) {
  if (!node || typeof node !== 'object') {
    return '';
  }

  if (node.nodeName === '#text') {
    return node.value || '';
  }

  return Array.isArray(node.childNodes)
    ? node.childNodes.map((childNode) => getNodeText(childNode)).join('')
    : '';
}

function getAttribute(node, name) {
  return node?.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function findNodesByTagName(node, tagName, matches = []) {
  if (!node || typeof node !== 'object') {
    return matches;
  }

  if (node.tagName === tagName) {
    matches.push(node);
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((childNode) => findNodesByTagName(childNode, tagName, matches));
  }

  return matches;
}

export function isValidLanguageTag(languageTag, { allowXDefault = false } = {}) {
  const tag = typeof languageTag === 'string' ? languageTag.trim() : '';
  if (!tag) {
    return false;
  }

  if (allowXDefault && tag.toLowerCase() === 'x-default') {
    return true;
  }

  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) {
    return false;
  }

  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch {
    return false;
  }
}

function cloneAstNode(node) {
  if (!node || typeof node !== 'object') {
    return node;
  }
  const cloned = { ...node };
  delete cloned.parentNode;
  if (Array.isArray(node.attrs)) {
    cloned.attrs = node.attrs.map((attr) => ({ ...attr }));
  }
  if (Array.isArray(node.childNodes)) {
    cloned.childNodes = node.childNodes.map((child) => cloneAstNode(child));
  }
  return cloned;
}

function hasAttribute(node, name) {
  const target = name.toLowerCase();
  return Boolean(node?.attrs?.some((attribute) => attribute.name.toLowerCase() === target));
}

function getAstAncestors(node) {
  const ancestors = [];
  let current = node?.parentNode;
  while (current) {
    if (typeof current.tagName === 'string') {
      ancestors.unshift(current);
    }
    current = current.parentNode;
  }
  return ancestors;
}

function parseSelectorListWithErrors(selectorText) {
  if (typeof selectorText !== 'string' || selectorText.trim() === '') {
    return { selectors: [], error: 'Selector must be a non-empty string.' };
  }

  const str = selectorText.trim();
  const len = str.length;
  let pos = 0;

  const skipWs = () => {
    const start = pos;
    while (pos < len && /\s/.test(str[pos])) {
      pos += 1;
    }
    return pos - start;
  };

  const matchPattern = (pattern) => {
    const match = pattern.exec(str.slice(pos));
    if (!match) {
      return null;
    }
    pos += match[0].length;
    return match[0];
  };

  const parseAttributeSelector = () => {
    pos += 1; // '['
    skipWs();
    const attrName = matchPattern(/^[A-Za-z_:][A-Za-z0-9_.:-]*/);
    if (!attrName) {
      throw new Error('Invalid attribute name in selector.');
    }
    skipWs();
    if (pos < len && str[pos] === ']') {
      pos += 1;
      return { name: attrName.toLowerCase(), op: null, value: null, caseInsensitive: false };
    }

    const op = matchPattern(/^(?:\^=|\$=|\*=|=)/);
    if (!op) {
      throw new Error(`Expected ']', '=', '^=', '$=', or '*=' in attribute selector for [${attrName}].`);
    }
    skipWs();

    let value = '';
    if (pos < len && (str[pos] === '"' || str[pos] === "'")) {
      const quote = str[pos];
      pos += 1;
      let closed = false;
      while (pos < len) {
        const ch = str[pos];
        if (ch === '\\' && pos + 1 < len) {
          value += str[pos + 1];
          pos += 2;
          continue;
        }
        if (ch === quote) {
          pos += 1;
          closed = true;
          break;
        }
        value += ch;
        pos += 1;
      }
      if (!closed) {
        throw new Error(`Unterminated quoted value in attribute selector [${attrName}].`);
      }
    } else {
      const unquoted = matchPattern(/^[A-Za-z0-9_-]+/);
      if (unquoted === null) {
        throw new Error(`Expected attribute value in selector [${attrName}${op}...].`);
      }
      value = unquoted;
    }

    skipWs();
    let caseInsensitive = false;
    if (pos < len && (str[pos] === 'i' || str[pos] === 'I')) {
      const nextChar = str[pos + 1];
      if (nextChar === ']' || /\s/.test(nextChar || '')) {
        caseInsensitive = true;
        pos += 1;
        skipWs();
      }
    }

    if (pos >= len || str[pos] !== ']') {
      throw new Error(`Expected ']' to close attribute selector [${attrName}].`);
    }
    pos += 1;
    return { name: attrName.toLowerCase(), op, value, caseInsensitive };
  };

  const parseCompound = () => {
    let tag = null;
    const ids = [];
    const classes = [];
    const attrs = [];
    let partCount = 0;

    if (pos < len && str[pos] === '*') {
      tag = '*';
      pos += 1;
      partCount += 1;
    } else if (pos < len && /[A-Za-z]/.test(str[pos])) {
      tag = matchPattern(/^[A-Za-z][A-Za-z0-9-]*/).toLowerCase();
      partCount += 1;
    }

    while (pos < len) {
      const ch = str[pos];
      if (ch === '#') {
        pos += 1;
        const id = matchPattern(/^[A-Za-z_-][A-Za-z0-9_-]*/);
        if (!id) {
          throw new Error('Invalid #id selector.');
        }
        ids.push(id);
        partCount += 1;
      } else if (ch === '.') {
        pos += 1;
        const className = matchPattern(/^[A-Za-z_-][A-Za-z0-9_-]*/);
        if (!className) {
          throw new Error('Invalid .class selector.');
        }
        classes.push(className);
        partCount += 1;
      } else if (ch === '[') {
        attrs.push(parseAttributeSelector());
        partCount += 1;
      } else {
        break;
      }
    }

    if (partCount === 0) {
      throw new Error(`Expected selector near "${str.slice(pos)}".`);
    }
    if (pos < len && !/[\s,>]/.test(str[pos])) {
      throw new Error(`Unsupported or invalid selector token "${str[pos]}" near "${str.slice(pos)}".`);
    }

    return { tag, ids, classes, attrs };
  };

  const parseComplex = () => {
    skipWs();
    if (pos >= len || str[pos] === ',' || str[pos] === '>') {
      throw new Error(`Unexpected token near "${str.slice(pos)}".`);
    }

    const segments = [{ combinator: null, compound: parseCompound() }];
    while (pos < len) {
      const wsCount = skipWs();
      if (pos >= len || str[pos] === ',') {
        break;
      }
      if (str[pos] === '>') {
        pos += 1;
        skipWs();
        if (pos >= len || str[pos] === ',' || str[pos] === '>') {
          throw new Error('Expected selector after ">" combinator.');
        }
        segments.push({ combinator: '>', compound: parseCompound() });
      } else if (wsCount > 0) {
        if (str[pos] === '+' || str[pos] === '~') {
          throw new Error(`Unsupported combinator "${str[pos]}".`);
        }
        segments.push({ combinator: ' ', compound: parseCompound() });
      } else {
        throw new Error(`Unexpected token "${str[pos]}" near "${str.slice(pos)}".`);
      }
    }
    return segments;
  };

  try {
    const selectors = [];
    while (pos < len) {
      selectors.push(parseComplex());
      skipWs();
      if (pos < len) {
        if (str[pos] === ',') {
          pos += 1;
          skipWs();
          if (pos >= len) {
            throw new Error('Trailing "," in selector list.');
          }
        } else {
          throw new Error(`Unexpected token "${str[pos]}" near "${str.slice(pos)}".`);
        }
      }
    }
    return { selectors, error: null };
  } catch (error) {
    return { selectors: [], error: error.message };
  }
}

/**
 * Validate `markdownStripSelectors` CSS selector strings.
 * Supports tag, `*`, `#id`, `.class`, `[attr]`, `[attr=val|^=|$=|*=]` (optional `i`),
 * compound selectors, descendant (` `), child (`>`), and comma (`,`) lists.
 *
 * @param {unknown} selectors - Candidate selector array
 * @returns {string[]} Validation error messages (`[]` if valid)
 */
export function validateMarkdownStripSelectors(selectors) {
  if (selectors === undefined) {
    return [];
  }
  if (!Array.isArray(selectors)) {
    return ["Option 'markdownStripSelectors' must be an array of CSS selector strings."];
  }
  const errors = [];
  selectors.forEach((selector, index) => {
    if (typeof selector !== 'string' || selector.trim() === '') {
      errors.push(`markdownStripSelectors[${index}] must be a non-empty CSS selector string.`);
      return;
    }
    const { error } = parseSelectorListWithErrors(selector);
    if (error) {
      errors.push(`Invalid CSS selector at markdownStripSelectors[${index}] ("${selector}"): ${error}`);
    }
  });
  return errors;
}

function compileMarkdownStripSelectors(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return [];
  }
  const compiled = [];
  for (const selector of selectors) {
    if (typeof selector !== 'string' || selector.trim() === '') continue;
    const { selectors: parsed, error } = parseSelectorListWithErrors(selector);
    if (!error) {
      compiled.push(...parsed);
    }
  }
  return compiled;
}

function matchesCompoundSelector(node, compound) {
  if (!node || typeof node.tagName !== 'string') {
    return false;
  }
  if (compound.tag && compound.tag !== '*' && node.tagName.toLowerCase() !== compound.tag) {
    return false;
  }
  if (compound.ids.length > 0) {
    const idValue = getAttribute(node, 'id');
    if (!compound.ids.every((id) => idValue === id)) {
      return false;
    }
  }
  if (compound.classes.length > 0) {
    const classTokens = getAttribute(node, 'class').split(/\s+/).filter(Boolean);
    if (!compound.classes.every((className) => classTokens.includes(className))) {
      return false;
    }
  }
  for (const attr of compound.attrs) {
    if (!hasAttribute(node, attr.name)) {
      return false;
    }
    if (attr.op === null) {
      continue;
    }
    const rawActual = getAttribute(node, attr.name);
    const actual = attr.caseInsensitive ? rawActual.toLowerCase() : rawActual;
    const expected = attr.caseInsensitive ? attr.value.toLowerCase() : attr.value;
    if (attr.op === '=') {
      if (actual !== expected) return false;
    } else if (attr.op === '^=') {
      if (!expected || !actual.startsWith(expected)) return false;
    } else if (attr.op === '$=') {
      if (!expected || !actual.endsWith(expected)) return false;
    } else if (attr.op === '*=') {
      if (!expected || !actual.includes(expected)) return false;
    }
  }
  return true;
}

function matchesComplexSelectorAt(segments, segmentIndex, node, ancestors, ancestorLimit) {
  const segment = segments[segmentIndex];
  if (!matchesCompoundSelector(node, segment.compound)) {
    return false;
  }
  if (segmentIndex === 0) {
    return true;
  }
  if (segment.combinator === '>') {
    if (ancestorLimit < 0) {
      return false;
    }
    return matchesComplexSelectorAt(
      segments,
      segmentIndex - 1,
      ancestors[ancestorLimit],
      ancestors,
      ancestorLimit - 1,
    );
  }
  for (let idx = ancestorLimit; idx >= 0; idx -= 1) {
    if (matchesComplexSelectorAt(segments, segmentIndex - 1, ancestors[idx], ancestors, idx - 1)) {
      return true;
    }
  }
  return false;
}

function isDefaultMarkdownNoiseNode(node) {
  if (!node || typeof node.tagName !== 'string') {
    return false;
  }
  const tagName = node.tagName.toLowerCase();
  if (MARKDOWN_STRIP_TAGS.has(tagName)) {
    return true;
  }
  if (hasAttribute(node, 'hidden') || hasAttribute(node, 'data-geo-ignore')) {
    return true;
  }
  if (getAttribute(node, 'aria-hidden').trim().toLowerCase() === 'true') {
    return true;
  }
  const roles = getAttribute(node, 'role').toLowerCase().split(/\s+/).filter(Boolean);
  if (roles.includes('navigation')) {
    return true;
  }
  if (getAttribute(node, 'aria-label').toLowerCase().includes('breadcrumb')) {
    return true;
  }
  return false;
}

function shouldStripMarkdownNode(node, ancestors, compiledStripSelectors) {
  if (isDefaultMarkdownNoiseNode(node)) {
    return true;
  }
  return compiledStripSelectors.some((segments) => (
    matchesComplexSelectorAt(segments, segments.length - 1, node, ancestors, ancestors.length - 1)
  ));
}

/**
 * Strip built-in noise and configured `markdownStripSelectors` nodes from parse5 AST.
 * Returns true if the root node itself should be dropped.
 */
function stripMarkdownNoiseNodes(node, ancestors, compiledStripSelectors) {
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (typeof node.tagName === 'string' && shouldStripMarkdownNode(node, ancestors, compiledStripSelectors)) {
    return true;
  }
  if (!Array.isArray(node.childNodes)) {
    return false;
  }

  const childAncestors = typeof node.tagName === 'string' ? [...ancestors, node] : ancestors;
  node.childNodes = node.childNodes.filter((childNode) => {
    if (typeof childNode?.tagName !== 'string') {
      return true;
    }
    return !stripMarkdownNoiseNodes(childNode, childAncestors, compiledStripSelectors);
  });
  return false;
}

function getNodeEdge(node, side) {
  if (!node || typeof node !== 'object' || node.nodeName === '#comment') {
    return null;
  }
  if (node.nodeName === '#text') {
    const val = node.value || '';
    if (!val) return null;
    const isWs = side === 'left' ? /^\s/.test(val) : /\s$/.test(val);
    if (isWs) return { kind: 'ws' };
    return { kind: 'char', char: side === 'left' ? val[0] : val[val.length - 1], text: val };
  }
  if (typeof node.tagName === 'string') {
    const tag = node.tagName.toLowerCase();
    if (tag === 'br' || tag === 'wbr') return { kind: 'ws' };
    if (tag === 'img') return { kind: 'img' };
    const children = node.childNodes || [];
    const start = side === 'left' ? 0 : children.length - 1;
    const step = side === 'left' ? 1 : -1;
    for (let idx = start; idx >= 0 && idx < children.length; idx += step) {
      const edge = getNodeEdge(children[idx], side);
      if (edge) return edge;
    }
  }
  return null;
}

function isBlockElementForSpacing(node) {
  if (!node || typeof node.tagName !== 'string') {
    return false;
  }
  const tag = node.tagName.toLowerCase();
  if (SPACING_BLOCK_TAGS.has(tag)) {
    return true;
  }
  if (tag === 'a') {
    return hasBlockDescendant(node);
  }
  return false;
}

function needsInlineSpaceBetween(prevNode, nextNode) {
  if (!prevNode || !nextNode) {
    return false;
  }
  if (isBlockElementForSpacing(prevNode) || isBlockElementForSpacing(nextNode)) {
    return false;
  }
  const prevTag = typeof prevNode.tagName === 'string' ? prevNode.tagName.toLowerCase() : '';
  const nextTag = typeof nextNode.tagName === 'string' ? nextNode.tagName.toLowerCase() : '';
  if (prevTag === 'sub' || prevTag === 'sup' || nextTag === 'sub' || nextTag === 'sup') {
    return false;
  }

  const rightEdge = getNodeEdge(prevNode, 'right');
  const leftEdge = getNodeEdge(nextNode, 'left');
  if (!rightEdge || !leftEdge) {
    return false;
  }
  if (rightEdge.kind === 'ws' || leftEdge.kind === 'ws') {
    return false;
  }

  if (rightEdge.kind === 'char') {
    if (OPENING_NO_SPACE_AFTER.has(rightEdge.char)) {
      return false;
    }
    if (rightEdge.char === '"' || rightEdge.char === "'") {
      const prevChar = rightEdge.text.length >= 2 ? rightEdge.text[rightEdge.text.length - 2] : '';
      if (!prevChar || /\s/.test(prevChar)) {
        return false;
      }
    }
  }

  if (leftEdge.kind === 'char') {
    if (CLOSING_NO_SPACE_BEFORE.has(leftEdge.char)) {
      return false;
    }
    if (leftEdge.char === '"' || leftEdge.char === "'") {
      const nextChar = leftEdge.text.length >= 2 ? leftEdge.text[1] : '';
      if (!nextChar || /[\s.,;:!?)\]}'"”’]|(?:^(?:s|t|re|ll|ve|d|m)\b)/i.test(leftEdge.text.slice(1))) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Prevent text gluing between adjacent inline elements/text nodes without
 * separating whitespace, while preserving pre/code whitespace and punctuation.
 */
function insertAdjacentInlineSpacing(node) {
  if (!node || typeof node !== 'object' || !Array.isArray(node.childNodes)) {
    return;
  }
  const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
  if (tag === 'pre' || tag === 'code') {
    return;
  }

  if (tag === 'details') {
    const cleanedChildren = [];
    let sawSummary = false;
    for (const child of node.childNodes) {
      if (child.nodeName === '#text') {
        if (/^\s*$/.test(child.value || '')) {
          continue;
        }
        if (sawSummary || cleanedChildren.length === 0) {
          child.value = (child.value || '').replace(/^\s+/, '');
        }
      } else if (typeof child.tagName === 'string' && child.tagName.toLowerCase() === 'summary') {
        sawSummary = true;
      }
      cleanedChildren.push(child);
    }
    node.childNodes = cleanedChildren;
  }

  for (const child of node.childNodes) {
    insertAdjacentInlineSpacing(child);
  }

  const nextChildren = [];
  let prevMeaningful = null;

  for (const child of node.childNodes) {
    const isComment = child.nodeName === '#comment';
    const hasContent = !isComment && (isBlockElementForSpacing(child) || getNodeEdge(child, 'left') !== null);
    if (hasContent && prevMeaningful && needsInlineSpaceBetween(prevMeaningful, child)) {
      nextChildren.push({ nodeName: '#text', value: ' ' });
    }
    nextChildren.push(child);
    if (hasContent) {
      prevMeaningful = child;
    }
  }

  node.childNodes = nextChildren;
}


// XML entity lookup (defined once, reused for all escapeXml calls)
const XML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const DECODED_XML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Escape XML special characters and strip XML 1.0 illegal control characters.
 * @param {unknown} str - Raw value
 * @returns {string} Escaped XML-safe string
 */
export function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[&<>"']/g, (char) => XML_ENTITIES[char]);
}

/**
 * Escape special characters for HTML attribute values.
 * @param {unknown} str - Raw attribute value
 * @returns {string} Escaped HTML-attribute-safe string
 */
export function escapeHtmlAttribute(str) {
  return sanitizeControlChars(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decode standard XML named and numeric entities safely in a single pass.
 * Out-of-range or surrogate numeric code points are left un-decoded rather than throwing.
 * @param {unknown} value - XML text
 * @returns {string} Decoded text
 */
export function decodeXmlEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    return DECODED_XML_ENTITIES[entity] ?? match;
  });
}

export function escapeMarkdownLinkLabel(label) {
  return sanitizeControlChars(label)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

export function escapeMarkdownLinkDestination(destination) {
  return sanitizeControlChars(destination)
    .trim()
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\s+/g, '%20');
}

function stripConfiguredPrefixes(filePath, stripPathPrefixes) {
  const normalizedPrefixes = (stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
    .map((prefix) => normalizeFilePath(prefix).replace(/\/+$/, ''))
    .filter(Boolean);

  let current = filePath;
  for (const prefix of normalizedPrefixes) {
    if (current === prefix) {
      return '';
    }
    if (current.startsWith(`${prefix}/`)) {
      return current.slice(prefix.length + 1);
    }
  }
  return current;
}

function getPageModel(options, filePath) {
  if (options.pageModels instanceof Map) {
    return options.pageModels.get(filePath);
  }
  if (Array.isArray(options.pageModels)) {
    return options.pageModels.find((page) => page.filePath === filePath);
  }
  return null;
}

/**
 * Normalize file path to POSIX-like format (internal helper).
 * @param {string} filePath - Any path
 * @returns {string} POSIX-like path
 */
export function normalizeFilePath(filePath) {
  if (filePath === undefined || filePath === null) {
    return '';
  }
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

/**
 * Extract lastmod timestamp from file or use build date.
 * @param {string} filePath - Absolute file path
 * @param {string} strategy - 'none', 'file-mtime', 'build', or 'git'
 * @param {string} buildDate - ISO 8601 build date
 * @param {{onWarning?: (message: string) => void}} [context={}] - Warning sink
 * @returns {string|null} Verified ISO 8601 timestamp, or null when unavailable
 */
export function extractLastmod(filePath, strategy, buildDate, context = {}) {
  const warn = typeof context.onWarning === 'function'
    ? context.onWarning
    : (message) => console.warn(message);

  if (!strategy || strategy === 'none') {
    return null;
  }

  if (strategy === 'build') {
    return buildDate || null;
  }

  if (strategy === 'git') {
    try {
      const resolvedPath = filePath ? resolve(filePath) : '';
      if (!resolvedPath || !existsSync(resolvedPath)) {
        warn(`⚠️  [Non-fatal] File not found for git lastmod: ${filePath}, omitting lastmod`);
        return null;
      }

      const result = spawnSync(
        'git',
        ['log', '-1', '--format=%cI', '--', basename(resolvedPath)],
        {
          cwd: dirname(resolvedPath),
          encoding: 'utf-8',
        },
      );
      const gitTimestamp = result.status === 0 ? result.stdout.trim() : '';

      if (gitTimestamp) {
        return gitTimestamp;
      }
      if (result.error) {
        warn(`⚠️  [Non-fatal] Failed to execute git lastmod for ${filePath}: ${result.error.message}, omitting lastmod`);
        return null;
      }
    } catch (error) {
      warn(`⚠️  [Non-fatal] Failed git lastmod for ${filePath}: ${error.message}, omitting lastmod`);
      return null;
    }
    warn(`⚠️  [Non-fatal] No git timestamp for ${filePath}, omitting lastmod`);
    return null;
  }

  try {
    if (!filePath || !existsSync(filePath)) {
      warn(`⚠️  [Non-fatal] File not found for mtime: ${filePath}, omitting lastmod`);
      return null;
    }

    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch (error) {
    warn(`⚠️  [Non-fatal] Failed to read mtime for ${filePath}: ${error.message}, omitting lastmod`);
    return null;
  }
}

/**
 * Resolve effective source path for lastmod timestamp lookup.
 * Strategy:
 * 1) Try mapped source HTML path(s) under sourceHtmlDir.
 * 2) Fallback to dist HTML file path.
 * 3) Return null if neither exists.
 *
 * @param {string} distHtmlFilePath - Absolute HTML file path in dist
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string} [options.sourceHtmlDir='src/pages'] - Source HTML directory
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip when mapping
 * @returns {string|null} Effective file path for mtime lookup
 */
export function resolveLastmodSourcePath(distHtmlFilePath, distDir, options = {}) {
  const sourceHtmlDir = options.sourceHtmlDir || 'src/pages';
  const projectRoot = options.projectRoot || process.cwd();
  const sourceRoot = isAbsolute(sourceHtmlDir)
    ? resolve(sourceHtmlDir)
    : resolve(projectRoot, sourceHtmlDir);

  if (isWithinDir(distDir, distHtmlFilePath)) {
    const relativePath = normalizeFilePath(relative(distDir, distHtmlFilePath));
    const stripPathPrefixes = (options.stripPathPrefixes || DEFAULT_STRIP_PATH_PREFIXES)
      .map((prefix) => normalizeFilePath(prefix).replace(/\/+$/, ''))
      .filter((prefix) => prefix.length > 0);

    const sourceCandidates = new Set([relativePath]);

    stripPathPrefixes.forEach((prefix) => {
      if (relativePath === prefix) {
        sourceCandidates.add('');
        return;
      }
      if (relativePath.startsWith(`${prefix}/`)) {
        sourceCandidates.add(relativePath.slice(prefix.length + 1));
      }
    });

    for (const candidate of sourceCandidates) {
      if (!candidate) {
        continue;
      }
      const sourceCandidatePath = resolve(sourceRoot, candidate);
      if (isWithinDir(sourceRoot, sourceCandidatePath) && existsSync(sourceCandidatePath)) {
        return sourceCandidatePath;
      }
    }
  }

  if (existsSync(distHtmlFilePath)) {
    return distHtmlFilePath;
  }

  return null;
}

function hasNoindexMeta(metaNodes) {
  return metaNodes.some((node) => {
    const name = getAttribute(node, 'name').toLowerCase().trim();
    const content = getAttribute(node, 'content').toLowerCase();
    return name === 'robots' && content.split(/[\s,]+/).includes('noindex');
  });
}

/**
 * Detect if HTML content contains noindex meta tag using the HTML5 parser (internal helper).
 * @param {string} htmlContent - Raw HTML content
 * @returns {boolean} True if noindex is present
 */
function detectNoindex(htmlContent) {
  const documentAst = parse(String(htmlContent || ''));
  return hasNoindexMeta(findNodesByTagName(documentAst, 'meta'));
}

/**
 * Simple glob pattern matcher (supports * and ** wildcards).
 * @param {string} pattern - Glob pattern
 * @param {string} str - String to match
 * @returns {boolean} True if matches
 */
export function matchGlob(pattern, str) {
  if (typeof pattern !== 'string' || typeof str !== 'string') {
    return false;
  }

  let regexSource = '^';
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith('**/', index)) {
      regexSource += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      regexSource += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      regexSource += '[^/]*';
      index += 1;
    } else {
      regexSource += pattern[index].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      index += 1;
    }
  }
  regexSource += '$';

  return new RegExp(regexSource).test(str);
}

/**
 * Match a page against glob patterns (`llmsMdMirrorInclude` / `llmsMdMirrorExclude` / etc.).
 * Normalizes leading `/` on patterns, handles root patterns (`''` / `'/'` / `'index'`),
 * and matches directory-index pages against `'dir/**'` (so `'guides/**'` matches `guides`).
 *
 * @param {string[]} patterns - Pattern list
 * @param {{pagePath?: string, relativePath?: string}} [page={}] - Page paths
 * @returns {boolean} True when any pattern matches
 */
export function matchesPagePatterns(patterns, page = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  const hasPagePath = page?.pagePath !== undefined && page?.pagePath !== null;
  const hasRelativePath = page?.relativePath !== undefined && page?.relativePath !== null;
  const normPagePath = hasPagePath ? normalizeFilePath(page.pagePath) : '';
  const normRelativePath = hasRelativePath ? normalizeFilePath(page.relativePath) : '';

  for (const rawPattern of patterns) {
    if (typeof rawPattern !== 'string') {
      continue;
    }
    const clean = rawPattern.trim().replace(/^\/+/, '');
    if (clean === '' || clean === 'index') {
      if (
        (hasPagePath && normPagePath === '')
        || normRelativePath === 'index.html'
        || (!hasPagePath && !hasRelativePath)
      ) {
        return true;
      }
      continue;
    }

    if (hasPagePath && matchGlob(clean, normPagePath)) {
      return true;
    }
    if (hasRelativePath && matchGlob(clean, normRelativePath)) {
      return true;
    }
    if (clean.endsWith('/**')) {
      const dirPrefix = clean.slice(0, -3);
      if (hasPagePath && normPagePath === dirPrefix) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determine whether a Markdown mirror should be generated for a given page.
 *
 * @param {{pagePath?: string, relativePath?: string}} page - Page paths
 * @param {object} [options={}] - Generator options
 * @returns {boolean} True if mirror should be emitted
 */
export function shouldGenerateMarkdownMirror(page, options = {}) {
  if (options?.llmsMdMirror === false) {
    return false;
  }
  if (Array.isArray(options?.llmsMdMirrorInclude)) {
    if (!matchesPagePatterns(options.llmsMdMirrorInclude, page)) {
      return false;
    }
  }
  if (
    Array.isArray(options?.llmsMdMirrorExclude)
    && matchesPagePatterns(options.llmsMdMirrorExclude, page)
  ) {
    return false;
  }
  return true;
}

/**
 * Classify HTML files as included or excluded without logging.
 * Excluded entries carry the reason so callers can aggregate diagnostics.
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {object} options - Filter options
 * @param {string[]} [options.excludePatterns] - Exclude patterns (glob)
 * @param {string} options.distDir - Output directory
 * @returns {{included: string[], excluded: string[], excludedDetails: Array<{filePath: string, reason: string}>}}
 */
export function classifyHtmlFiles(htmlFiles, options = {}) {
  const { excludePatterns = DEFAULT_EXCLUDE_PATTERNS, distDir } = options;
  const normalizedPatterns = Array.isArray(excludePatterns)
    ? excludePatterns.filter((pattern) => typeof pattern === 'string' && pattern.length > 0)
    : DEFAULT_EXCLUDE_PATTERNS;
  const included = [];
  const excluded = [];

  for (const filePath of htmlFiles) {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const fileName = basename(filePath);
    let shouldExclude = false;
    let excludeReason = '';
    
    // Check default excludes (404.html, 500.html)
    if (DEFAULT_EXCLUDE_PATTERNS.includes(fileName)) {
      shouldExclude = true;
      excludeReason = 'default exclude';
    }
    
    // Check custom exclude patterns
    if (!shouldExclude && normalizedPatterns.length > 0) {
      for (const pattern of normalizedPatterns) {
        if (matchGlob(pattern, relativePath) || matchGlob(pattern, fileName)) {
          shouldExclude = true;
          excludeReason = `matches pattern: ${pattern}`;
          break;
        }
      }
    }
    
    // Check noindex meta tag
    if (!shouldExclude && existsSync(filePath)) {
      try {
        const htmlContent = readFileSync(filePath, 'utf-8');
        if (detectNoindex(htmlContent)) {
          shouldExclude = true;
          excludeReason = 'contains noindex meta tag';
        }
      } catch (error) {
        console.warn(`⚠️  [Non-fatal] Failed to read ${filePath} for noindex detection: ${error.message}`);
        // Continue processing - don't exclude due to read error
      }
    }
    
    if (shouldExclude) {
      excluded.push({ filePath, reason: excludeReason });
    } else {
      included.push(filePath);
    }
  }

  return {
    included,
    excluded: excluded.map((entry) => entry.filePath),
    excludedDetails: excluded,
  };
}

/**
 * Filter HTML files by applying noindex detection and custom exclude patterns.
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {object} options - Filter options
 * @param {string[]} [options.excludePatterns] - Exclude patterns (glob)
 * @param {string} options.distDir - Output directory
 * @returns {Promise<{included: string[], excluded: string[]}>}
 */
export async function filterHtmlFiles(htmlFiles, options) {
  const { included, excluded, excludedDetails } = classifyHtmlFiles(htmlFiles, options);

  // Log excluded files
  if (excludedDetails.length > 0) {
    console.log(`\n🚫 Excluded ${excludedDetails.length} file(s):`);
    excludedDetails.forEach(({ filePath, reason }) => {
      const fileName = basename(filePath);
      console.log(`   - ${fileName} (${reason})`);
    });
  }

  return {
    included,
    excluded,
  };
}

/**
 * Normalize a route base path to canonical `'' | '/' | '/path/'` form.
 * Rejects absolute URLs (for example a CDN `base`); callers must set
 * `routeBasePath` explicitly when the site is served from a path.
 * @param {string} value - Raw route base path
 * @param {{source?: string}} [context={}] - Error context
 * @returns {string} Canonical route base path
 */
export function normalizeRouteBasePath(value, context = {}) {
  const source = context.source || 'routeBasePath';

  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw new Error(`${source} must be a string URL path such as "/docs/".`);
  }

  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('\\')) {
    throw new Error(`Invalid ${source}: "${value.trim()}". Use a URL path such as "/docs/".`);
  }

  const raw = value.trim();
  if (raw === '' || raw === './') {
    return '';
  }
  if (raw === '/') {
    return '/';
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.startsWith('//')) {
    throw new Error(
      `${source} must be a URL path such as "/docs/", not an absolute URL: "${raw}". `
      + 'Set `routeBasePath` explicitly to the path the site is served from.',
    );
  }

  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (!pathOnly) {
    throw new Error(`Invalid ${source}: "${raw}". Use a URL path such as "/docs/".`);
  }

  const segments = pathOnly.split('/').filter(Boolean);
  for (const segment of segments) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      throw new Error(`Invalid ${source}: "${raw}" contains malformed percent encoding.`);
    }
    if (
      segment === '.'
      || segment === '..'
      || decodedSegment === '.'
      || decodedSegment === '..'
      || decodedSegment.includes('/')
      || decodedSegment.includes('\\')
    ) {
      throw new Error(`Invalid ${source}: "${raw}". Path segments must not be "." or "..".`);
    }
  }

  return segments.length > 0 ? `/${segments.join('/')}/` : '';
}

/**
 * Compose page URL by joining site URL + route base path + page path.
 * @param {string} siteUrl - Site URL in metadata
 * @param {string} pagePath - Page path without leading slash
 * @param {string} [routeBasePath=''] - Optional route base path
 * @param {object} [urlOptions={}] - URL formatting options (`trailingSlash`)
 * @returns {string} Final absolute URL
 */
export function composePageUrl(siteUrl, pagePath, routeBasePath = '', urlOptions = {}) {
  const normalizedBasePath = normalizeRouteBasePath(routeBasePath)
    .replace(/^\/+|\/+$/g, '');
  const normalizedPagePath = normalizeFilePath(pagePath);
  const joinedPath = [normalizedBasePath, normalizedPagePath]
    .filter(Boolean)
    .join('/');

  const baseUrl = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const useTrailingSlash = urlOptions?.trailingSlash === 'always';

  if (!joinedPath) {
    if (useTrailingSlash) {
      return baseUrl;
    }
    return siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  }

  const segments = joinedPath.split('/').filter((segment) => segment && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Invalid page path "${pagePath}": path segments must not be "..".`);
  }

  const safePath = segments
    .map((segment) => segment.replace(/#/g, '%23').replace(/\?/g, '%3F'))
    .join('/');

  const rawUrl = new URL(`/${safePath}`, baseUrl).toString().replace(/\/$/, '');
  if (useTrailingSlash) {
    const lastSegment = segments[segments.length - 1] || '';
    if (!normalizedPagePath || !/\.[a-z0-9]+$/i.test(lastSegment)) {
      return `${rawUrl}/`;
    }
  }
  return rawUrl;
}

function composePublicFileUrl(siteUrl, filePath, routeBasePath = '', urlOptions = {}) {
  const raw = String(filePath ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw) || raw.startsWith('//')) {
    throw new Error(`Invalid public file URL: "${String(filePath ?? '')}".`);
  }

  if (ABSOLUTE_URL_SCHEME_PATTERN.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid public file URL: "${raw}".`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid public file URL "${raw}": must use http:// or https://.`);
    }
    return raw;
  }

  return composePageUrl(siteUrl, raw, routeBasePath, urlOptions);
}

function collectHtmlFilesRecursive(dirPath, htmlFiles) {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.vite-plugin-geo-')) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectHtmlFilesRecursive(fullPath, htmlFiles);
    } else if (entry.isFile() && /\.html$/i.test(entry.name)) {
      htmlFiles.push(fullPath);
    }
  }
}

/**
 * Recursively find all HTML files in a directory.
 * @param {string} dirPath - Directory path
 * @param {string[]} [htmlFiles=[]] - Recursive accumulator
 * @returns {string[]} HTML file absolute paths
 */
export function findHtmlFiles(dirPath, htmlFiles = []) {
  if (!existsSync(dirPath)) {
    return htmlFiles;
  }

  collectHtmlFilesRecursive(dirPath, htmlFiles);
  return htmlFiles.sort(compareCodeUnits);
}

/**
 * Unified page path resolver - combines path normalization, prefix stripping, and pretty URL conversion.
 * This is the primary function for converting HTML file paths to URL paths.
 *
 * @param {string} relativePath - Relative path from dist directory
 * @param {object} [options={}] - Options
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip (e.g., ['src/pages/'])
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @returns {string} Resolved page path without leading slash
 */
export function resolvePagePath(relativePath, options = {}) {
  const prettyUrls = options.prettyUrls !== false;

  // Step 1: Normalize file path and strip configured prefixes
  let path = stripConfiguredPrefixes(
    normalizeFilePath(relativePath),
    options.stripPathPrefixes,
  );

  // Step 2: Apply strict prettyUrls semantics while keeping homepage special-case.
  // - prettyUrls: true  => remove ".html" and collapse "*/index.html" to directory path
  // - prettyUrls: false => keep ".html" for non-home pages
  if (path === 'index' || path === 'index.html') {
    path = '';
  } else if (path.endsWith('/index') || path.endsWith('/index.html')) {
    if (prettyUrls) {
      path = path.replace(/\/index(?:\.html)?$/, '');
    } else if (!path.endsWith('.html')) {
      path = `${path}.html`;
    }
  } else if (/\.html$/i.test(path)) {
    if (prettyUrls) {
      path = path.slice(0, -'.html'.length);
    }
  }

  return path;
}

function normalizeMarkdownOutput(markdownContent) {
  const raw = String(markdownContent || '').replace(/\r\n/g, '\n');
  const normalizedLines = [];
  let consecutiveBlank = 0;

  forEachMarkdownLine(raw, (line, inFence) => {
    if (inFence) {
      consecutiveBlank = 0;
      normalizedLines.push(line);
      return;
    }

    const cleanLine = line
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+$/, '')
      .replace(/^(\s*(?:-|\d+\.))\s+/, '$1 ');

    if (cleanLine === '') {
      consecutiveBlank += 1;
      if (consecutiveBlank <= 1) {
        normalizedLines.push('');
      }
      return;
    }

    consecutiveBlank = 0;
    normalizedLines.push(cleanLine);
  });

  return normalizedLines.join('\n').trim();
}

function resolveEffectiveBaseUrl(documentAst, baseUrl) {
  if (!baseUrl) {
    return '';
  }

  const baseNode = findFirstNodeByTagName(documentAst, 'base');
  const href = getAttribute(baseNode, 'href').trim();
  if (!href) {
    return baseUrl;
  }

  return resolveHttpUrl(href, baseUrl) || baseUrl;
}

function resolveResourceUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('#') || ABSOLUTE_URL_SCHEME_PATTERN.test(raw)) {
    return value;
  }

  return resolveHttpUrl(raw, baseUrl) || value;
}

function rewriteImageSources(node, baseUrl) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (node.tagName === 'img') {
    const src = getAttribute(node, 'src');
    const resolved = src ? resolveResourceUrl(src, baseUrl) : src;
    if (resolved && resolved !== src) {
      const srcAttribute = node.attrs?.find((attribute) => attribute.name.toLowerCase() === 'src');
      if (srcAttribute) {
        srcAttribute.value = resolved;
      }
    }
  }

  if (Array.isArray(node.childNodes)) {
    node.childNodes.forEach((childNode) => rewriteImageSources(childNode, baseUrl));
  }
}

/**
 * Convert HTML content to Markdown format.
 * The page's semantic content container is preferred; body fallback removes
 * site chrome so mirrors keep mainly the title, description, and article body.
 *
 * @param {object} documentAst - parse5 document AST
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Public URL of the built HTML file
 * @returns {string} Markdown formatted content
 */
function convertHtmlAstToMarkdown(documentAst, { baseUrl = '', markdownStripSelectors = [] } = {}) {
  const effectiveBaseUrl = resolveEffectiveBaseUrl(documentAst, baseUrl);
  const compiledStripSelectors = compileMarkdownStripSelectors(markdownStripSelectors);

  const convertRootNode = (rootNode, bodyFallback) => {
    const rootAncestors = getAstAncestors(rootNode);
    const workingRoot = cloneAstNode(rootNode);
    if (stripMarkdownNoiseNodes(workingRoot, rootAncestors, compiledStripSelectors)) {
      return '';
    }
    if (bodyFallback) {
      stripBodyChromeNodes(workingRoot);
    }
    if (effectiveBaseUrl) {
      rewriteImageSources(workingRoot, effectiveBaseUrl);
    }
    insertAdjacentInlineSpacing(workingRoot);

    const cleanedHtml = (serialize(workingRoot) || '').trim();
    if (!cleanedHtml) {
      return '';
    }

    return normalizeMarkdownOutput(turndownService.turndown(cleanedHtml));
  };

  const selection = selectMarkdownContentRoot(documentAst);
  const markdown = convertRootNode(selection.node, selection.bodyFallback);
  if (markdown || selection.bodyFallback) {
    return markdown;
  }

  // An empty semantic container (for example an app shell) should not suppress
  // readable body content. Retry with the body and its chrome cleanup.
  const bodyNode = findFirstNodeByTagName(documentAst, 'body');
  return bodyNode ? convertRootNode(bodyNode, true) : '';
}

export function convertHtmlToMarkdown(htmlContent, options = {}) {
  if (typeof htmlContent !== 'string' || htmlContent.trim() === '') {
    return '';
  }

  try {
    const documentAst = parse(htmlContent);
    return convertHtmlAstToMarkdown(documentAst, options);
  } catch (error) {
    console.warn(`⚠️  [Non-fatal] Failed HTML->Markdown conversion: ${error.message}, fallback to text-only mode`);

    return htmlContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function downgradeRemainingAtxH1(markdownBody) {
  const output = [];

  forEachMarkdownLine(markdownBody, (line, inFence) => {
    if (inFence) {
      output.push(line);
      return;
    }

    const h1Match = line.match(/^(\s{0,3})#(?!#)(\s+.*)$/);
    if (h1Match) {
      output.push(`${h1Match[1]}##${h1Match[2]}`);
    } else {
      output.push(line);
    }
  });

  return output.join('\n');
}

/**
 * Compose a mirror with a title heading, description blockquote, and the
 * content extracted from the built page. A leading H1 identical to the title
 * is removed so the mirror does not repeat the same heading, and any remaining
 * ATX `# ` headings outside fenced code blocks are downgraded to `## `.
 *
 * @param {object} page - Page model with title, description, and markdown
 * @returns {string} Mirror body (without the ownership marker)
 */
export function composeMarkdownMirrorContent({ title, description, markdown } = {}) {
  const normalizedTitle = normalizeInlineText(title);
  const normalizedDescription = normalizeInlineText(description);
  let body = String(markdown || '').replace(/\r\n/g, '\n').trim();

  if (normalizedTitle && body) {
    const lines = body.split('\n');
    const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
    if (firstContentIndex !== -1) {
      const headingMatch = lines[firstContentIndex].trim().match(LEADING_H1_PATTERN);
      if (
        headingMatch
        && normalizeInlineText(headingMatch[1]).toLowerCase() === normalizedTitle.toLowerCase()
      ) {
        lines.splice(firstContentIndex, 1);
        while (firstContentIndex < lines.length && lines[firstContentIndex].trim() === '') {
          lines.splice(firstContentIndex, 1);
        }
        body = lines.join('\n').trim();
      }
    }

    if (body) {
      body = downgradeRemainingAtxH1(body).trim();
    }
  }

  const parts = [];
  if (normalizedTitle) {
    parts.push(`# ${normalizedTitle}`);
  }
  if (
    normalizedDescription
    && normalizedDescription.toLowerCase() !== normalizedTitle.toLowerCase()
  ) {
    parts.push(`> ${normalizedDescription}`);
  }
  if (body) {
    parts.push(body);
  }

  return parts.join('\n\n');
}

export function analyzeHtmlPage(htmlContent, {
  audit = false,
  baseUrl = '',
  skipMarkdown = false,
  markdownStripSelectors = [],
} = {}) {
  const source = String(htmlContent || '');
  const documentAst = parse(source);
  const titleNode = findFirstNodeByTagName(documentAst, 'title');
  const htmlNode = findFirstNodeByTagName(documentAst, 'html');
  const metaNodes = findNodesByTagName(documentAst, 'meta');
  const linkNodes = findNodesByTagName(documentAst, 'link');
  const descriptionNode = metaNodes.find(
    (node) => getAttribute(node, 'name').toLowerCase() === 'description',
  );
  const noindex = hasNoindexMeta(metaNodes);
  // Declared alternates are cheap to collect here and drive per-page hreflang
  // in the sitemap when `hreflangFromHtml` is enabled.
  const hreflang = [];
  let canonicalHref = '';
  for (const link of linkNodes) {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const href = getAttribute(link, 'href').trim();
    if (!canonicalHref && relTokens.includes('canonical') && href) {
      canonicalHref = href;
    }
    const languageTag = getAttribute(link, 'hreflang').trim();
    if (!relTokens.includes('alternate') || !languageTag || !href) continue;
    hreflang.push({ hreflang: languageTag, href });
  }

  const documentBaseUrl = baseUrl ? resolveEffectiveBaseUrl(documentAst, baseUrl) : '';

  return {
    title: getNodeText(titleNode).trim(),
    description: getAttribute(descriptionNode, 'content').trim(),
    lang: getAttribute(htmlNode, 'lang').trim(),
    noindex,
    canonicalHref,
    hreflang,
    documentBaseUrl,
    ...(audit ? { audit: collectAuditFacts(documentAst) } : {}),
    markdown: (skipMarkdown || noindex)
      ? ''
      : convertHtmlAstToMarkdown(documentAst, { baseUrl, markdownStripSelectors }),
  };
}

function resolveHttpUrl(value, baseUrl) {
  try {
    const resolved = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function normalizeComparableUrl(value) {
  try {
    const resolved = new URL(value);
    resolved.hash = '';
    const serialized = resolved.toString();
    // /en/ and /en address the same page; keep the site root slash so that
    // https://example.test/ still matches its canonical serialization.
    return resolved.pathname !== '/' && serialized.endsWith('/')
      ? serialized.slice(0, -1)
      : serialized;
  } catch {
    return null;
  }
}

/**
 * Resolve the first valid Markdown alternate declared by an HTML page.
 * @param {string} htmlContent - Raw HTML source
 * @param {string} pageUrl - Absolute public page URL
 * @param {{documentBaseUrl?: string}} [options={}] - Optional base URL override
 * @returns {string|null} Absolute Markdown URL
 */
export function resolveMarkdownAlternateUrl(htmlContent, pageUrl, { documentBaseUrl } = {}) {
  const documentAst = parse(String(htmlContent || ''));
  const linkBaseUrl = resolveEffectiveBaseUrl(documentAst, documentBaseUrl || pageUrl);
  const links = findNodesByTagName(documentAst, 'link');

  for (const link of links) {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const type = getAttribute(link, 'type').toLowerCase();
    if (!relTokens.includes('alternate') || type !== 'text/markdown') {
      continue;
    }
    const resolved = resolveHttpUrl(getAttribute(link, 'href'), linkBaseUrl);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Derive the Markdown mirror path from the public page path.
 * The result is what gets emitted into dist and is also the public mirror URL,
 * so it must never contain the HTML bundle path or intermediate prefixes.
 * @param {string} pagePath - Public page path from resolvePagePath ('' for home)
 * @param {'append'|'replace'} style - Mirror naming style
 * @returns {string} Markdown mirror path relative to dist root
 */
export function resolveMarkdownMirrorPath(pagePath, style = 'append') {
  const normalizedPath = normalizeFilePath(pagePath);

  if (!normalizedPath || normalizedPath === 'index' || normalizedPath === 'index.html') {
    return 'index.md';
  }

  if (style === 'replace' && /\.html?$/i.test(normalizedPath)) {
    return normalizedPath.replace(/\.html?$/i, '.md');
  }

  return `${normalizedPath}.md`;
}

/**
 * Resolve the public URL of the built HTML file, used as the base for
 * absolutizing relative image sources in Markdown mirrors.
 * @param {string} relativePath - HTML path relative to dist root
 * @param {string} siteUrl - Site origin
 * @param {object} [options] - Resolved geo options
 * @returns {string} Absolute HTML file URL
 */
export function resolveMarkdownResourceBaseUrl(relativePath, siteUrl, options = {}) {
  const filePagePath = resolvePagePath(relativePath, { ...options, prettyUrls: false });
  const fileUrl = composePageUrl(siteUrl, filePagePath, options.routeBasePath);

  // Home pages are directories, so relative resources must resolve against a
  // trailing-slash base rather than treating the last segment as a file.
  if (!filePagePath) {
    return fileUrl.endsWith('/') ? fileUrl : `${fileUrl}/`;
  }

  return fileUrl;
}

function findRealHeadEndOffset(source, documentAst) {
  const headEnd = findFirstNodeByTagName(documentAst, 'head')?.sourceCodeLocation?.endTag?.startOffset;
  if (typeof headEnd === 'number') {
    return { offset: headEnd, fromAst: true };
  }

  if (!/<\/head\b/i.test(source)) {
    return { offset: -1, fromAst: false };
  }

  const tokenPattern = /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>|(<\/head\b[^>]*>)/gi;
  let match;
  while ((match = tokenPattern.exec(source)) !== null) {
    if (match[1]) {
      return { offset: match.index, fromAst: false };
    }
  }

  return { offset: -1, fromAst: false };
}

/**
 * Add llms.txt v2 discovery links without replacing unrelated page metadata.
 * @param {string} htmlContent - Raw HTML source
 * @param {object} links - Discovery targets
 * @param {string|null} links.markdownUrl - Absolute Markdown alternate URL
 * @param {string} links.llmsUrl - Absolute scoped llms.txt URL
 * @param {string} links.pageUrl - Absolute public page URL
 * @param {string} [links.documentBaseUrl] - Document URL base for relative link resolution
 * @returns {string} Updated HTML source
 */
export function injectLlmsDiscoveryLinks(htmlContent, {
  markdownUrl,
  llmsUrl,
  pageUrl,
  documentBaseUrl,
  onInspect,
  inspectionFacts,
}) {
  const source = String(htmlContent || '');
  const quickHasHeadEnd = /<\/head\b/i.test(source);
  if (!quickHasHeadEnd && inspectionFacts) {
    onInspect?.(null, [], inspectionFacts);
    return source;
  }
  if (!quickHasHeadEnd && !onInspect) {
    return source;
  }

  const documentAst = parse(source, { sourceCodeLocationInfo: true });
  const astHeadEnd = findFirstNodeByTagName(documentAst, 'head')?.sourceCodeLocation?.endTag?.startOffset;
  const regexHeadEnd = source.search(/<\/head>/i);
  const { offset: scannedHeadEnd, fromAst } = findRealHeadEndOffset(source, documentAst);
  // If an explicit </head> AST node exists, require the leading </head> match to align
  // with it so comments/scripts containing literal "</head>" are never mutated into
  // corrupted markup while keeping existing audit expectations consistent.
  const canInsert = fromAst
    ? astHeadEnd === regexHeadEnd
    : scannedHeadEnd !== -1;
  const headEndOffset = canInsert ? scannedHeadEnd : -1;

  if (!canInsert) {
    if (onInspect) {
      if (inspectionFacts) {
        onInspect(null, [], inspectionFacts);
      } else {
        onInspect(documentAst, []);
      }
    }
    return source;
  }

  const linkBaseUrl = resolveEffectiveBaseUrl(documentAst, documentBaseUrl || pageUrl);
  const links = findNodesByTagName(documentAst, 'link');
  const hasMarkdownAlternate = links.some((link) => {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    if (!relTokens.includes('alternate') || getAttribute(link, 'type').toLowerCase() !== 'text/markdown') {
      return false;
    }
    return Boolean(resolveHttpUrl(getAttribute(link, 'href'), linkBaseUrl));
  });
  const hasLlmsDescription = links.some((link) => {
    const relTokens = getAttribute(link, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    const resolvedHref = resolveHttpUrl(getAttribute(link, 'href'), linkBaseUrl);
    return relTokens.includes('describedby')
      && getAttribute(link, 'type').toLowerCase() === 'text/markdown'
      && resolvedHref === llmsUrl;
  });

  const additions = [];
  const addedLinks = [];
  if (markdownUrl && !hasMarkdownAlternate) {
    addedLinks.push({ rel: 'alternate', type: 'text/markdown', href: markdownUrl, hreflang: '' });
    additions.push(`<link rel="alternate" type="text/markdown" href="${escapeHtmlAttribute(markdownUrl)}" />`);
  }
  if (!hasLlmsDescription) {
    addedLinks.push({ rel: 'describedby', type: 'text/markdown', href: llmsUrl, hreflang: '' });
    additions.push(`<link rel="describedby" type="text/markdown" href="${escapeHtmlAttribute(llmsUrl)}" />`);
  }

  const updated = additions.length === 0
    ? source
    : `${source.slice(0, headEndOffset)}${additions.join('')}${source.slice(headEndOffset)}`;

  if (onInspect) {
    if (!fromAst && additions.length > 0) {
      // An implicit head has no AST endTag source location; inspect re-parsed HTML.
      onInspect(parse(updated), []);
    } else {
      onInspect(documentAst, addedLinks);
    }
  }
  return updated;
}

/**
 * Group candidates that resolve to the same public page path and resolve
 * conflicts deterministically.
 *
 * By default a duplicate route throws: silently dropping a page hides it from
 * sitemap, feed, and llms.txt without any signal. `routeConflict: 'first'` or
 * `'last'` opts into the previous lenient behavior.
 *
 * @param {Map<string, Array<{relativePath: string}>>} groups - pagePath -> candidates
 * @param {object} [options={}] - Options
 * @param {'error'|'first'|'last'} [options.routeConflict='error'] - Conflict policy
 * @returns {{selected: Array<object>, conflicts: Array<{pagePath: string, route: string, files: string[], chosen: string}>}}
 */
export function resolvePagePathConflicts(groups, options = {}) {
  const policy = options.routeConflict || 'error';
  const selected = [];
  const conflicts = [];

  for (const [pagePath, entries] of groups) {
    if (entries.length === 1) {
      selected.push(entries[0]);
      continue;
    }

    const sorted = [...entries].sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath));
    const files = sorted.map((entry) => entry.relativePath);
    const route = pagePath ? `/${pagePath}` : '/';

    if (policy === 'error') {
      throw new Error(
        `Route conflict: ${files.length} files map to the same public page "${route}": ${files.join('、')}. `
        + "Remove or rename one of them, or set routeConflict: 'first' or 'last' to choose deterministically.",
      );
    }

    const chosen = policy === 'last' ? sorted[sorted.length - 1] : sorted[0];
    conflicts.push({ pagePath, route, files, chosen: chosen.relativePath });
    selected.push(chosen);
  }

  selected.sort((a, b) => compareCodeUnits(a.relativePath, b.relativePath));
  return { selected, conflicts };
}

/**
 * Dedupe HTML files by route page path.
 * @param {string[]} htmlFiles - Candidate absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {'error'|'first'|'last'} [options.routeConflict] - Conflict policy
 * @returns {string[]} Dedupe HTML file paths
 */
export function dedupeHtmlFilesByPagePath(htmlFiles, distDir, options = {}) {
  const groups = new Map();

  for (const filePath of htmlFiles) {
    const relativePath = normalizeFilePath(relative(distDir, filePath));
    const pagePath = resolvePagePath(relativePath, options);
    if (!groups.has(pagePath)) groups.set(pagePath, []);
    groups.get(pagePath).push({ filePath, relativePath });
  }

  const { selected } = resolvePagePathConflicts(groups, options);
  return selected
    .map((entry) => entry.filePath)
    .sort(compareCodeUnits);
}

/**
 * Extract page title + meta description from HTML source.
 * @param {string} htmlContent - Raw HTML source
 * @returns {{title: string, description: string}}
 */
export function extractPageMetadata(htmlContent, options = {}) {
  const { includeLang = false } = options;
  const analyzed = analyzeHtmlPage(htmlContent, { skipMarkdown: true });
  const { title, description } = analyzed;

  const result = { title, description };

  if (includeLang) {
    result.lang = analyzed.lang;
  }

  return result;
}

/**
 * Generate sitemap.xml content with support for splitting and hreflang.
 * Uses metadata caching for improved performance.
 * 
 * @param {string} baseUrl - Site URL
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {string} currentDate - Date string in YYYY-MM-DD or ISO 8601
 * @param {object} [options={}] - Options
 * @param {string} [options.routeBasePath=''] - Optional route base path
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {string} [options.sourceHtmlDir='src/pages'] - Source HTML directory for mtime lookup
 * @param {string} [options.lastmodStrategy='none'] - 'none', 'file-mtime', 'build', or 'git'
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {boolean} [options.sitemapIndex=true] - Enable sitemap splitting
 * @param {object} [options.hreflang] - Hreflang configuration {langCode: urlPattern}
 * @returns {Array<{filename: string, content: string}>} Array of sitemap files
 */
export function generateSitemap(baseUrl, htmlFiles, distDir, currentDate, options = {}) {
  const parsedCurrentDate = new Date(currentDate);
  if (Number.isNaN(parsedCurrentDate.getTime())) {
    throw new Error(`Invalid build date for sitemap: "${String(currentDate)}".`);
  }

  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);
  const lastmodStrategy = options.lastmodStrategy || 'none';
  const buildDate = String(currentDate).includes('T') ? String(currentDate) : parsedCurrentDate.toISOString();
  const prettyUrls = options.prettyUrls !== false;
  const sitemapIndex = options.sitemapIndex !== false; // Default to true
  const sitemapMaxBytes = options.sitemapMaxBytes || SITEMAP_MAX_BYTES;
  const hreflangConfig = options.hreflang;
  const hreflangFromHtml = options.hreflangFromHtml === true;

  // Check if we need xmlns:xhtml namespace for hreflang
  const needsXhtmlNamespace = (hreflangConfig && Object.keys(hreflangConfig).length > 0)
    || (hreflangFromHtml && dedupedHtmlFiles.some(
      (filePath) => (getPageModel(options, filePath)?.hreflang || []).length > 0,
    ));

  const urlEntries = dedupedHtmlFiles.map((filePath) => {
    const pageModel = getPageModel(options, filePath);
    const relativePath = pageModel?.relativePath || normalizeFilePath(relative(distDir, filePath));
    // Use unified resolvePagePath with prettyUrls option
    const pagePath = pageModel && pageModel.pagePath !== undefined
      ? pageModel.pagePath
      : resolvePagePath(relativePath, { ...options, prettyUrls });

    const loc = pageModel?.pageUrl || composePageUrl(baseUrl, pagePath, options.routeBasePath, options);
    // pageModel.mtime already contains the lastmodResolver result and the
    // configured strategy. Do not short-circuit on strategy 'none' here:
    // a resolver is allowed to provide timestamps with the default strategy.
    const lastmod = pageModel
      ? pageModel.mtime
      : (lastmodStrategy === 'none'
        ? null
        : extractLastmod(resolveLastmodSourcePath(filePath, distDir, options) || filePath, lastmodStrategy, buildDate));

    // Per-page declarations win when enabled; pages without any fall back to
    // the global hreflang patterns.
    let hreflangLinks = [];
    if (hreflangFromHtml && pageModel?.hreflang?.length > 0) {
      hreflangLinks = generateHreflangLinksFromHtml(
        pageModel.hreflang,
        pageModel.lang,
        loc,
        baseUrl,
        pageModel.documentBaseUrl || pageModel.filePageUrl || loc,
      );
    } else if (hreflangConfig) {
      hreflangLinks = generateHreflangLinks(pagePath, hreflangConfig, baseUrl);
    }

    let urlEntry = `  <url>\n    <loc>${escapeXml(loc)}</loc>`;
    if (lastmod) {
      urlEntry += `\n    <lastmod>${escapeXml(lastmod)}</lastmod>`;
    }

    if (hreflangLinks.length > 0) {
      urlEntry += '\n' + hreflangLinks.join('\n');
    }

    urlEntry += '\n  </url>';

    return urlEntry;
  });

  const xmlnsXhtml = needsXhtmlNamespace ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
  const totalBytes = getSitemapByteLength(urlEntries, xmlnsXhtml);

  if (!sitemapIndex && urlEntries.length > SITEMAP_MAX_URLS) {
    throw new Error('Sitemap exceeds the 50,000 URL limit while sitemapIndex is disabled.');
  }

  // Check if we need to split the sitemap by URL count or protocol byte limit.
  if (
    sitemapIndex
    && (urlEntries.length > SITEMAP_MAX_URLS || totalBytes > sitemapMaxBytes)
  ) {
    const sitemapFiles = splitSitemap(urlEntries, {
      maxUrlsPerFile: SITEMAP_MAX_URLS,
      maxBytesPerFile: sitemapMaxBytes,
      xmlnsXhtml,
    });

    if (sitemapFiles.length === 1 && sitemapFiles[0].filename === 'sitemap.xml') {
      return sitemapFiles;
    }

    if (sitemapFiles.length > SITEMAP_MAX_URLS) {
      throw new Error('Sitemap index exceeds the 50,000 sitemap file limit.');
    }

    // Generate sitemap index
    const sitemapIndexContent = generateSitemapIndex(
      sitemapFiles.map((f) => f.filename),
      baseUrl,
      lastmodStrategy === 'none' ? null : buildDate,
      options.routeBasePath,
      options,
    );

    if (Buffer.byteLength(sitemapIndexContent, 'utf-8') > SITEMAP_MAX_BYTES) {
      throw new Error('Sitemap index exceeds the 50 MiB protocol byte limit.');
    }

    return [
      ...sitemapFiles,
      { filename: 'sitemap_index.xml', content: sitemapIndexContent },
    ];
  }

  if (totalBytes > sitemapMaxBytes) {
    throw new Error('Sitemap exceeds the configured byte limit while sitemapIndex is disabled.');
  }

  // Single sitemap file
  return [{ filename: 'sitemap.xml', content: buildSitemapXml(urlEntries, xmlnsXhtml) }];
}

function getSitemapWrapperBytes(xmlnsXhtml = '') {
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generated by vite-plugin-geo -->\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlnsXhtml}>\n`;
  const footer = '\n</urlset>';
  return Buffer.byteLength(header, 'utf-8') + Buffer.byteLength(footer, 'utf-8');
}

function getSitemapByteLength(urlEntries, xmlnsXhtml = '') {
  let totalBytes = getSitemapWrapperBytes(xmlnsXhtml);
  for (let index = 0; index < urlEntries.length; index += 1) {
    if (index > 0) {
      totalBytes += 1; // '\n' separator
    }
    totalBytes += Buffer.byteLength(urlEntries[index], 'utf-8');
  }
  return totalBytes;
}

function buildSitemapXml(urlEntries, xmlnsXhtml = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by vite-plugin-geo -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlnsXhtml}>
${urlEntries.join('\n')}
</urlset>`;
}

/**
 * Split sitemap URLs into multiple files if exceeding the limit (internal helper).
 * @param {string[]} urlEntries - Serialized URL entries
 * @param {object} [options={}] - Split limits
 * @param {number} [options.maxUrlsPerFile=50000] - Maximum URLs per sitemap file
 * @param {number} [options.maxBytesPerFile=52428800] - Maximum uncompressed sitemap bytes
 * @param {string} [options.xmlnsXhtml=''] - Optional xhtml namespace
 * @returns {Array<{filename: string, content: string}>} Array of sitemap files
 */
function splitSitemap(urlEntries, options = {}) {
  const maxUrlsPerFile = options.maxUrlsPerFile || SITEMAP_MAX_URLS;
  const maxBytesPerFile = options.maxBytesPerFile || SITEMAP_MAX_BYTES;
  const xmlnsXhtml = options.xmlnsXhtml || '';
  const wrapperBytes = getSitemapWrapperBytes(xmlnsXhtml);

  const chunks = [];
  let currentChunk = [];
  let currentBytes = wrapperBytes;

  for (const entry of urlEntries) {
    const entryBytes = Buffer.byteLength(entry, 'utf-8');
    if (wrapperBytes + entryBytes > maxBytesPerFile) {
      throw new Error('A single sitemap entry exceeds the configured byte limit.');
    }

    const addedBytes = currentChunk.length === 0 ? entryBytes : 1 + entryBytes;
    const exceedsUrlLimit = currentChunk.length + 1 > maxUrlsPerFile;
    const exceedsByteLimit = currentBytes + addedBytes > maxBytesPerFile;

    if (currentChunk.length > 0 && (exceedsUrlLimit || exceedsByteLimit)) {
      chunks.push(currentChunk);
      currentChunk = [entry];
      currentBytes = wrapperBytes + entryBytes;
      continue;
    }

    currentChunk.push(entry);
    currentBytes += addedBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length <= 1) {
    return [{ filename: 'sitemap.xml', content: buildSitemapXml(chunks[0] || [], xmlnsXhtml) }];
  }

  return chunks.map((chunk, index) => ({
    filename: `sitemap_${index + 1}.xml`,
    content: buildSitemapXml(chunk, xmlnsXhtml),
  }));
}
/**
 * Generate sitemap index file referencing multiple sitemap files (internal helper).
 * @param {Array<string>} sitemapFiles - Array of sitemap filenames (e.g., ['sitemap_1.xml', 'sitemap_2.xml'])
 * @param {string} baseUrl - Site base URL
 * @param {string|null} lastmod - ISO 8601 timestamp for lastmod, or null to omit
 * @returns {string} sitemap_index.xml content
 */
function generateSitemapIndex(sitemapFiles, baseUrl, lastmod, routeBasePath = '', urlOptions = {}) {
  const sitemapEntries = sitemapFiles.map((filename) => {
    const loc = composePageUrl(baseUrl, filename, routeBasePath, urlOptions);
    return `  <sitemap>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `
    <lastmod>${escapeXml(lastmod)}</lastmod>` : ''}
  </sitemap>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by vite-plugin-geo -->
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</sitemapindex>`;
}
/**
 * Build xhtml:link elements from alternates declared in one page's HTML.
 * Declarations are authoritative; a self entry is synthesized from
 * `<html lang>` when missing, and x-default is never invented.
 */
function generateHreflangLinksFromHtml(declared, lang, pageUrl, baseUrl, documentBaseUrl = '') {
  const links = new Map();
  const relativeBaseUrl = documentBaseUrl || pageUrl || baseUrl;

  for (const entry of declared) {
    const languageTag = String(entry?.hreflang || '').trim();
    if (!languageTag || !isValidLanguageTag(languageTag, { allowXDefault: true })) continue;
    const href = resolveHttpUrl(entry?.href, relativeBaseUrl);
    if (!href) continue;
    const normalizedKey = languageTag.toLowerCase();
    if (!links.has(normalizedKey)) {
      links.set(normalizedKey, { hreflang: languageTag, href });
    }
  }

  const normalizedLang = String(lang || '').trim();
  const selfUrl = resolveHttpUrl(pageUrl || baseUrl, baseUrl);
  const comparableSelfUrl = selfUrl ? normalizeComparableUrl(selfUrl) : null;
  if (normalizedLang && selfUrl && isValidLanguageTag(normalizedLang)) {
    // Any declared non-x-default alternate that resolves to this page counts
    // as the self reference, even when its tag differs from <html lang>
    // (for example en-US vs en). x-default is a fallback, not a language.
    const hasSelf = comparableSelfUrl !== null && [...links.values()].some(({ hreflang, href }) => (
      hreflang.toLowerCase() !== 'x-default'
      && normalizeComparableUrl(href) === comparableSelfUrl
    ));
    const selfKey = normalizedLang.toLowerCase();
    if (!hasSelf && !links.has(selfKey)) {
      links.set(selfKey, { hreflang: normalizedLang, href: selfUrl });
    }
  }

  return [...links.values()]
    .sort((a, b) => compareCodeUnits(a.hreflang.toLowerCase(), b.hreflang.toLowerCase())
      || compareCodeUnits(a.href, b.href))
    .map(({ hreflang, href }) => (
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}"/>`
    ));
}

/**
 * Generate hreflang links for a page (internal helper).
 * @param {string} pagePath - Page path (without .html)
 * @param {object} hreflangConfig - Language code to URL pattern mapping
 * @param {string} baseUrl - Site base URL
 * @returns {string[]} Array of xhtml:link elements
 */
function generateHreflangLinks(pagePath, hreflangConfig, baseUrl) {
  if (!hreflangConfig || typeof hreflangConfig !== 'object') {
    return [];
  }

  const hreflangLinks = [];

  for (const [langCode, urlPattern] of Object.entries(hreflangConfig)) {
    if (!isValidLanguageTag(langCode, { allowXDefault: true })) {
      console.warn(`⚠️  Invalid BCP 47 language code: ${langCode}, skipping`);
      continue;
    }

    if (typeof urlPattern !== 'string' || !urlPattern.trim()) {
      continue;
    }

    // Generate URL by replacing {path} placeholder
    let url = urlPattern.includes('{path}')
      ? urlPattern.replaceAll('{path}', pagePath)
      : urlPattern;

    // Ensure URL is absolute http(s)
    if (!/^https?:\/\//i.test(url)) {
      if (ABSOLUTE_URL_SCHEME_PATTERN.test(url) || url.startsWith('//')) {
        console.warn(`⚠️  Invalid hreflang URL pattern for "${langCode}": ${url}, skipping`);
        continue;
      }
      url = `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/${url.replace(/^\//, '')}`;
    }

    // Generate xhtml:link element
    hreflangLinks.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(langCode)}" href="${escapeXml(url)}"/>`);
  }

  return hreflangLinks;
}
/**
 * Generate humans.txt content following humanstxt.org standard.
 * @param {object} packageJson - Parsed package.json content
 * @param {string} buildDate - ISO 8601 build date
 * @param {object} helpers - Helper functions from geoMetadataResolver
 * @param {Function} helpers.extractTeamInfoFromPackageJson - Team info extractor
 * @param {Function} helpers.extractTechStackFromPackageJson - Tech stack extractor
 * @returns {string} humans.txt content
 */
export function generateHumansTxt(packageJson, buildDate, helpers = {}) {
  const lines = [];

  // Use provided helper functions or create minimal fallback
  const extractTeamInfo = helpers.extractTeamInfoFromPackageJson || (() => ({ author: null, contributors: [] }));
  const extractTechStack = helpers.extractTechStackFromPackageJson || (() => []);

  const teamInfo = extractTeamInfo(packageJson);
  const techStack = extractTechStack(packageJson);

  if (teamInfo.author) {
    const authorLines = [];
    const authorName = sanitizeControlChars(teamInfo.author.name).trim();
    const authorEmail = sanitizeControlChars(teamInfo.author.email).trim();
    const authorUrl = sanitizeControlChars(teamInfo.author.url).trim();
    if (authorName) {
      authorLines.push(`  Developer: ${authorName}`);
    }
    if (authorEmail) {
      authorLines.push(`  Contact: ${authorEmail}`);
    }
    if (authorUrl) {
      authorLines.push(`  From: ${authorUrl}`);
    }
    if (authorLines.length > 0) {
      lines.push('/* TEAM */', ...authorLines, '');
    }
  }

  const contributorNames = (teamInfo.contributors || [])
    .map((contributor) => sanitizeControlChars(contributor?.name).trim())
    .filter(Boolean);
  if (contributorNames.length > 0) {
    lines.push('/* THANKS */');
    contributorNames.forEach((name) => lines.push(`  ${name}`));
    lines.push('');
  }

  lines.push('/* SITE */');
  const date = new Date(buildDate);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid buildDate for humans.txt: "${String(buildDate)}".`);
  }
  const formattedDate = date.toISOString().split('T')[0];
  lines.push(`  Last update: ${formattedDate}`);

  const cleanTechStack = (techStack || [])
    .map((tech) => sanitizeControlChars(tech).trim())
    .filter(Boolean);
  if (cleanTechStack.length > 0) {
    lines.push(`  Components: ${cleanTechStack.join(', ')}`);
  }

  return `${lines.join('\n')}\n`;
}
/**
 * Convert ISO 8601 date to RFC 822 format (required by RSS 2.0) (internal helper).
 * @param {string} isoDate - ISO 8601 date string
 * @returns {string} RFC 822 formatted date
 */
function toRFC822Date(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date for RSS feed: "${String(isoDate)}".`);
  }

  // RFC 822 format: "Day, DD Mon YYYY HH:MM:SS GMT"
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} GMT`;
}

/**
 * 检测 feed 内容的格式类型
 * @param {string} feedContent - feed 文件内容
 * @returns {'rss' | 'atom'} feed 格式类型
 */
export function detectFeedFormat(feedContent) {
  // Atom 格式: <feed xmlns="http://www.w3.org/2005/Atom">
  if (/<feed[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(feedContent)) {
    return 'atom';
  }
  // RSS 格式: <rss version="...">
  if (/<rss[^>]*version=/i.test(feedContent)) {
    return 'rss';
  }
  // 默认返回 rss
  return 'rss';
}

export function injectFeedLink(htmlContent, feedHref) {
  const source = String(htmlContent ?? '');
  const newFeedLink = `<link rel="alternate" type="application/rss+xml" title="RSS Feed" href="${escapeHtmlAttribute(feedHref)}" />`;
  const documentAst = parse(source, { sourceCodeLocationInfo: true });
  const headNode = findFirstNodeByTagName(documentAst, 'head');
  const linkNodes = findNodesByTagName(headNode || documentAst, 'link');

  const feedLinks = linkNodes.filter((link) => {
    const rel = getAttribute(link, 'rel').toLowerCase();
    const type = getAttribute(link, 'type').toLowerCase();
    const title = getAttribute(link, 'title').toLowerCase();
    return rel.split(/\s+/).includes('alternate')
      && (
        type === 'application/rss+xml'
        || type === 'application/atom+xml'
        || title === 'rss feed'
        || title === 'atom feed'
      )
      && typeof link.sourceCodeLocation?.startOffset === 'number'
      && typeof link.sourceCodeLocation?.endOffset === 'number';
  });

  if (feedLinks.length > 0) {
    const edits = feedLinks
      .map((link, index) => ({
        startOffset: link.sourceCodeLocation.startOffset,
        endOffset: link.sourceCodeLocation.endOffset,
        replacement: index === 0 ? newFeedLink : '',
      }))
      .sort((a, b) => a.startOffset - b.startOffset);

    let cursor = 0;
    let output = '';
    for (const edit of edits) {
      output += source.slice(cursor, edit.startOffset) + edit.replacement;
      cursor = edit.endOffset;
    }
    return output + source.slice(cursor);
  }

  const { offset: headEndOffset } = findRealHeadEndOffset(source, documentAst);
  if (headEndOffset === -1) {
    return source;
  }

  return `${source.slice(0, headEndOffset)}${newFeedLink}${source.slice(headEndOffset)}`;
}

function parseTimestampMs(value) {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Generate RSS 2.0 feed.xml content.
 * @param {Array<{url: string, title: string, description: string, mtime: string}>} pages - Page metadata array
 * @param {object} siteMetadata - Site metadata
 * @param {string} siteMetadata.url - Site URL
 * @param {string} siteMetadata.title - Site title
 * @param {string} siteMetadata.description - Site description
 * @param {string} siteMetadata.lang - Site language
 * @param {string} buildDate - ISO 8601 build date
 * @returns {string} feed.xml content
 */
export function generateFeedXml(pages, siteMetadata, buildDate, options = {}) {
  const { url, title, description, lang } = siteMetadata;
  const feedUrl = siteMetadata.feedUrl || new URL('feed.xml', `${url.replace(/\/+$/, '')}/`).toString();

  // Sort pages by mtime descending (newest first), tie-breaking deterministically by URL
  const sortedPages = [...(Array.isArray(pages) ? pages : [])].sort((a, b) => {
    const dateA = parseTimestampMs(a?.mtime);
    const dateB = parseTimestampMs(b?.mtime);
    if (dateB !== dateA) {
      return dateB - dateA;
    }
    return compareCodeUnits(a?.url, b?.url);
  });
  const feedPages = Number.isInteger(options?.maxItems) && options.maxItems > 0
    ? sortedPages.slice(0, options.maxItems)
    : sortedPages;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
  lines.push('  <channel>');
  lines.push(`    <title>${escapeXml(title)}</title>`);
  lines.push(`    <link>${escapeXml(url)}</link>`);
  lines.push(`    <description>${escapeXml(description)}</description>`);
  lines.push(`    <language>${escapeXml(lang)}</language>`);
  lines.push(`    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`);
  lines.push(`    <lastBuildDate>${toRFC822Date(buildDate)}</lastBuildDate>`);
  lines.push('');

  // Generate item elements for each page
  feedPages.forEach((page) => {
    lines.push('    <item>');
    lines.push(`      <title>${escapeXml(page.title)}</title>`);
    lines.push(`      <link>${escapeXml(page.url)}</link>`);
    lines.push(`      <description>${escapeXml(page.description)}</description>`);
    if (page.mtime && !Number.isNaN(new Date(page.mtime).getTime())) {
      lines.push(`      <pubDate>${toRFC822Date(page.mtime)}</pubDate>`);
    }
    lines.push(`      <guid isPermaLink="true">${escapeXml(page.url)}</guid>`);
    lines.push('    </item>');
  });

  lines.push('  </channel>');
  lines.push('</rss>');

  return lines.join('\n');
}

/**
 * Generate llms.txt content.
 * @param {object} siteMetadata - Site metadata
 * @param {string[]} htmlFiles - Absolute HTML file paths
 * @param {string} distDir - Dist output directory
 * @param {object} [options={}] - Options
 * @param {string} [options.routeBasePath=''] - Optional route base path
 * @param {string[]} [options.stripPathPrefixes] - Prefixes to strip
 * @param {boolean} [options.prettyUrls=true] - Enable Pretty URLs (remove .html)
 * @param {string} [options.sitemapUrl='sitemap.xml'] - Public sitemap URL or path
 * @returns {string} llms.txt
 */
export function generateLlmsTxt(siteMetadata, htmlFiles, distDir, options = {}) {
  const { url, title, description } = siteMetadata;
  const pages = collectLlmsPages(siteMetadata, htmlFiles, distDir, options);
  const groupedPages = groupLlmsPages(pages);

  const safeTitle = sanitizeControlChars(title).trim();
  const safeDescription = sanitizeControlChars(description).trim();

  const lines = [];
  lines.push(`# ${safeTitle}`);
  lines.push('');

  if (safeDescription) {
    lines.push(`> ${safeDescription}`);
    lines.push('');
  }

  groupedPages.forEach(({ section, pages: sectionPages }) => {
    lines.push(`## ${sanitizeControlChars(section).trim()}`);
    sectionPages.forEach((page) => {
      lines.push(
        `- [${escapeMarkdownLinkLabel(page.title)}](${escapeMarkdownLinkDestination(page.url)}): ${truncateLlmsDescription(page.description)}`,
      );
    });
    lines.push('');
  });

  if (Array.isArray(options.skuMd?.catalog) && options.skuMd.catalog.length > 0) {
    lines.push('## Product Catalog');
    options.skuMd.catalog.forEach(({ label, url: catalogUrl }) => {
      lines.push(
        `- [${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkDestination(catalogUrl)}): Browse the merchant storefront catalog`,
      );
    });
    lines.push('');
  }

  if (options.includeOptional !== false) {
    const optionalLinks = [];
    if (options.includeSitemap !== false) {
      const sitemapHref = composePublicFileUrl(url, options.sitemapUrl || 'sitemap.xml', options.routeBasePath, options);
      optionalLinks.push(`- [Sitemap](${escapeMarkdownLinkDestination(sitemapHref)}): Complete list of all indexed pages`);
    }
    if (options.includeRobots ?? (options.generateRobots !== false)) {
      const robotsHref = composePageUrl(url, 'robots.txt', '', options);
      optionalLinks.push(`- [robots.txt](${escapeMarkdownLinkDestination(robotsHref)}): Search engine crawling instructions`);
    }
    if (optionalLinks.length > 0) {
      lines.push('## Optional', ...optionalLinks);
    }
  }

  return lines.join('\n');
}

function collectLlmsPages(siteMetadata, htmlFiles, distDir, options = {}) {
  const { url } = siteMetadata;
  const prettyUrls = options.prettyUrls !== false;
  const llmsMdMirror = options.llmsMdMirror !== false; // Default to true
  const dedupedHtmlFiles = dedupeHtmlFilesByPagePath(htmlFiles, distDir, options);

  return dedupedHtmlFiles.map((filePath) => {
    const pageModel = getPageModel(options, filePath);
    const relativePath = pageModel?.relativePath || normalizeFilePath(relative(distDir, filePath));
    const metadata = pageModel || extractPageMetadata(readFileSync(filePath, 'utf-8'));
    const pagePath = pageModel && pageModel.pagePath !== undefined
      ? pageModel.pagePath
      : resolvePagePath(relativePath, { ...options, prettyUrls });
    const resolveMirrorUrl = () => (
      llmsMdMirror && shouldGenerateMarkdownMirror({ pagePath, relativePath }, options)
        ? composePageUrl(
          url,
          resolveMarkdownMirrorPath(pagePath, options.llmsMdMirrorStyle),
          options.routeBasePath,
          options,
        )
        : null
    );
    const mirrorUrl = pageModel
      ? (pageModel.markdownUrl === null ? null : (pageModel.markdownUrl || resolveMirrorUrl()))
      : resolveMirrorUrl();
    const pageUrl = mirrorUrl || pageModel?.pageUrl || composePageUrl(url, pagePath, options.routeBasePath, options);
    const page = {
      filePath,
      relativePath,
      pagePath,
      url: pageUrl,
      title: metadata.title || 'Untitled',
      description: metadata.description || metadata.title || 'Page content',
      isHome: pagePath === '',
    };

    return {
      ...page,
      section: resolveLlmsSection(page, options),
    };
  }).sort((a, b) => {
    if (a.isHome && !b.isHome) return -1;
    if (!a.isHome && b.isHome) return 1;
    return compareCodeUnits(a.url, b.url);
  });
}

function resolveLlmsSection(page, options = {}) {
  if (typeof options.llmsClassify === 'function') {
    const section = options.llmsClassify(page);
    if (typeof section === 'string') {
      const sanitized = sanitizeControlChars(section).trim();
      if (sanitized) {
        return sanitized;
      }
    }
  }

  if (options.llmsSections && typeof options.llmsSections === 'object' && !Array.isArray(options.llmsSections)) {
    for (const [section, patterns] of Object.entries(options.llmsSections)) {
      const patternList = Array.isArray(patterns) ? patterns : [patterns];
      if (patternList.some((pattern) => pattern && page.relativePath.includes(String(pattern)))) {
        return sanitizeControlChars(section).trim() || 'Docs';
      }
    }
  }

  const path = page.relativePath.toLowerCase();
  if (/(^|\/)(api|reference|sdk)(\/|\.|-|$)/.test(path)) {
    return 'API';
  }
  if (/(^|\/)(examples?|demos?|samples?|tutorials?)(\/|\.|-|$)/.test(path) || path.includes('convert')) {
    return 'Examples';
  }
  return 'Docs';
}

function groupLlmsPages(pages) {
  const preferredOrder = ['Docs', 'Examples', 'API'];
  const sectionMap = new Map();
  pages.forEach((page) => {
    if (!sectionMap.has(page.section)) {
      sectionMap.set(page.section, []);
    }
    sectionMap.get(page.section).push(page);
  });

  const sections = [
    ...preferredOrder.filter((section) => sectionMap.has(section)),
    ...Array.from(sectionMap.keys()).filter((section) => !preferredOrder.includes(section)).sort(compareCodeUnits),
  ];

  return sections.map((section) => ({
    section,
    pages: sectionMap.get(section),
  }));
}

function truncateLlmsDescription(description) {
  const normalizedDescription = sanitizeControlChars(description).replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(normalizedDescription);
  if (codePoints.length <= 80) {
    return normalizedDescription;
  }
  return `${codePoints.slice(0, 77).join('')}...`;
}

/**
 * Generate robots.txt content following RFC 9309 processing limits.
 * @param {string} baseUrl - Origin-only site URL
 * @param {object} [options={}] - Generator options
 * @param {string} [options.routeBasePath=''] - Public sitemap base path
 * @param {string[]} [options.robotsDirectives=[]] - Custom robots directives
 * @param {string} [options.sitemapUrl='sitemap.xml'] - Public sitemap URL or path
 * @returns {string} robots.txt
 */
export function generateRobotsTxt(baseUrl, options = {}) {
  const rawDirectives = options.robotsDirectives;
  if (rawDirectives !== undefined && !Array.isArray(rawDirectives)) {
    throw new Error('robotsDirectives must be an array of non-empty strings.');
  }

  const robotsDirectives = rawDirectives || [];
  robotsDirectives.forEach((directive) => {
    if (/[\u0000-\u001F\u007F]/.test(String(directive))) {
      throw new Error('robotsDirectives must not contain control characters.');
    }
  });

  const lines = [
    `# robots.txt for ${new URL(baseUrl).hostname}`,
    '# See https://www.rfc-editor.org/rfc/rfc9309',
    '',
    'User-agent: *',
    'Allow: /',
  ];
  if (robotsDirectives.length > 0) {
    lines.push('', '# Custom directives', ...robotsDirectives);
  }
  if (options.includeSitemap !== false) {
    lines.push(
      '',
      `Sitemap: ${composePublicFileUrl(baseUrl, options.sitemapUrl || 'sitemap.xml', options.routeBasePath, options)}`,
    );
  }

  const content = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(content, 'utf-8') > 500 * 1024) {
    throw new Error('robots.txt exceeds the 500 KiB processing limit.');
  }
  return content;
}
