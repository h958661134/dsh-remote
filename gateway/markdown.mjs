/**
 * Minimal, dependency-free Markdown renderer for the local viewer.
 *
 * Scope matters more than completeness here: the viewer exists so a phone or a
 * browser that cannot load the harness document preview can still read a .md
 * file. It escapes all HTML first, then recognises a small, predictable subset
 * of Markdown, so a malicious file cannot inject markup.
 *
 * Supported: headings, fenced code, inline code, bold, italic, strikethrough,
 * links (http/https/mailto/#relative only), images (rendered as links), block
 * quotes, ordered/unordered lists with one level of nesting, tables, rules,
 * paragraphs and hard line breaks.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml (text) {
  return String(text).replace(/[&<>"']/g, (character) => ESCAPES[character])
}

function safeUrl (raw) {
  const url = String(raw || '').trim()
  if (!url) return null
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url
  if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url
  // relative like docs/foo.md
  if (/^[a-z0-9._~\-/%]+(\?[^\s]*)?(#\S*)?$/i.test(url) && !/^[a-z]+:/i.test(url)) return url
  return null
}

function inline (escaped) {
  const codes = []
  let text = escaped.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000CODE${codes.length - 1}\u0000`
  })

  // linked image: [![alt](image)](link) -> plain link (no remote image loading)
  text = text.replace(/\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, image, link) => {
    const safe = safeUrl(link) || safeUrl(image)
    const label = alt || 'image'
    if (!safe) return label
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  // images -> links (no remote image loading)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, url) => {
    const safe = safeUrl(url)
    if (!safe) return match
    return `[${alt || safe}](${safe})`
  })

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, url) => {
    const safe = safeUrl(url)
    if (!safe) return label
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  text = text.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`)
  return text
}

function splitRow (line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
}

export function renderMarkdown (source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    // fenced code
    const fence = /^(\s*)(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const indent = fence[1].length
      const marker = fence[2]
      const language = fence[3]
      const body = []
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        const closed = new RegExp(`^\\s*${marker}\\s*$`).test(current)
        if (closed) { index += 1; break }
        body.push(current.slice(Math.min(indent, current.length)))
        index += 1
      }
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : ''
      out.push(`<pre class="md-code"><code${languageClass}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    // blank line
    if (/^\s*$/.test(line)) { index += 1; continue }

    // horizontal rule
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); index += 1; continue }

    // heading
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`)
      index += 1
      continue
    }

    // table
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*\s*$/.test(lines[index + 1])) {
      const header = splitRow(line)
      index += 2
      const rows = []
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      const thead = '<thead><tr>' + header.map((cell) => `<th>${inline(escapeHtml(cell))}</th>`).join('') + '</tr></thead>'
      const tbody = '<tbody>' + rows.map((row) => '<tr>' + row.map((cell) => `<td>${inline(escapeHtml(cell))}</td>`).join('') + '</tr>').join('') + '</tbody>'
      out.push(`<table class="md-table">${thead}${tbody}</table>`)
      continue
    }

    // blockquote
    if (/^\s{0,3}>/.test(line)) {
      const body = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`)
      continue
    }

    // lists
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[2])
      const items = []
      while (index < lines.length) {
        const current = lines[index]
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current)
        if (match) {
          items.push({ depth: Math.min(2, Math.floor(match[1].length / 2)), html: inline(escapeHtml(match[3])) })
          index += 1
          continue
        }
        if (/^\s{2,}\S/.test(current) && items.length > 0) {
          items[items.length - 1].html += '<br>' + inline(escapeHtml(current.trim()))
          index += 1
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      let html = `<${tag} class="md-list">`
      let depth = 0
      for (const item of items) {
        while (depth < item.depth) { html += `<${tag}>`; depth += 1 }
        while (depth > item.depth) { html += `</${tag}>`; depth -= 1 }
        html += `<li>${item.html}</li>`
      }
      while (depth > 0) { html += `</${tag}>`; depth -= 1 }
      html += `</${tag}>`
      out.push(html)
      continue
    }

    // paragraph
    const paragraph = []
    while (index < lines.length && !/^\s*$/.test(lines[index]) &&
      !/^(\s*)(```|~~~)/.test(lines[index]) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[index]) &&
      !/^\s{0,3}>/.test(lines[index]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    if (paragraph.length > 0) {
      out.push(`<p>${inline(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br>')}</p>`)
    } else {
      index += 1
    }
  }

  return out.join('\n')
}
