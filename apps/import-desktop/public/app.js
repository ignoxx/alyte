const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="local-token"]').content;
let selected = null,
  result = null,
  preview = null,
  running = false;
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, {
    ...options,
    headers: { 'x-local-token': token, ...options.headers },
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}
function controls() {
  $('file').disabled = running;
  $('retry').disabled = running || !selected;
  $('export').disabled = !result;
  $('clear').disabled = !selected && !result && !running;
}
function showRows(data) {
  result = data;
  $('rows').replaceChildren();
  const rows = data.measurements;
  $('table-wrap').hidden = !rows.length;
  $('results-empty').hidden = !!rows.length;
  $('results-empty').textContent =
    'No measurement candidates recovered. The original is still available.';
  $('count').textContent =
    `${rows.length} rows · ${rows.filter((r) => r.unresolvedFields.length).length} need review`;
  for (const row of rows) {
    const tr = document.createElement('tr');
    const values = [
      row.sourceLabel,
      row.valueString ?? '—',
      row.unit ?? '—',
      row.referenceInterval ?? '—',
      row.page ?? '—',
      row.unresolvedFields.length
        ? row.unresolvedFields.join(', ').replaceAll('-', ' ')
        : 'Check against source',
    ];
    values.forEach((value, i) => {
      const td = document.createElement('td');
      td.textContent = value;
      if (i === 5) td.className = row.unresolvedFields.length ? 'review' : 'ok';
      if (i === 0 && row.canonicalBiomarkerId) {
        const small = document.createElement('small');
        small.textContent = row.canonicalBiomarkerId;
        td.append(small);
      }
      tr.append(td);
    });
    $('rows').append(tr);
  }
}
async function refresh() {
  const state = await (await api('status')).json();
  $('model').textContent = state.modelAvailable
    ? 'PDFKit + Vision + local PaddleOCR · model loads only when needed'
    : 'PDFKit + Vision ready · PaddleOCR not installed. Run npm run setup:models --workspace=@alyte/import-desktop to enable the hybrid path.';
  if (state.state !== 'empty' && !preview) {
    const source = await (await api('source')).blob();
    selected = new File([source], 'imported-report.pdf', { type: 'application/pdf' });
    preview = URL.createObjectURL(source);
    $('preview').src = preview;
    $('preview').hidden = false;
    $('preview-empty').hidden = true;
    $('filename').textContent = 'Imported report';
  }
  running = state.state === 'running';
  if (running)
    $('status').textContent =
      `Reading and organizing locally… ${Math.floor((Date.now() - state.startedAt) / 1000)}s. First use also compiles the native readers.`;
  if (state.state === 'complete' || state.state === 'failed') {
    if (state.result) {
      showRows(state.result);
      const counts = state.result.diagnostics.counts;
      $('status').textContent =
        state.error ??
        `Finished in ${(state.result.elapsedMs / 1000).toFixed(1)}s · ${counts.trustedPdfPages} text pages · ${counts.visionInputPages} Vision pages · ${counts.modelCalls} model calls${counts.modelRecoveryIncomplete ? ' · Model recovery was incomplete; check for missing results.' : ''}`;
    } else $('status').textContent = state.error;
  }
  controls();
}
async function start() {
  if (!selected) return;
  running = true;
  result = null;
  controls();
  $('rows').replaceChildren();
  $('table-wrap').hidden = true;
  $('results-empty').hidden = false;
  $('results-empty').textContent = 'Reading your report…';
  $('status').textContent = 'Starting local import…';
  try {
    await api('import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: selected,
    });
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(selected);
    $('preview').src = preview;
    $('preview').hidden = false;
    $('preview-empty').hidden = true;
    await refresh();
  } catch (error) {
    running = false;
    $('status').textContent = error.message;
    controls();
  }
}
$('file').addEventListener('change', () => {
  selected = $('file').files[0] ?? null;
  $('filename').textContent = selected?.name ?? 'No report selected';
  void start();
});
$('retry').addEventListener('click', () => void start());
$('clear').addEventListener('click', async () => {
  try {
    await api('import', { method: 'DELETE' });
    if (preview) URL.revokeObjectURL(preview);
    preview = null;
    selected = null;
    result = null;
    running = false;
    $('file').value = '';
    $('filename').textContent = 'No report selected';
    $('preview').removeAttribute('src');
    $('preview').hidden = true;
    $('preview-empty').hidden = false;
    $('rows').replaceChildren();
    $('table-wrap').hidden = true;
    $('results-empty').hidden = false;
    $('results-empty').textContent = 'Ready for another report.';
    $('count').textContent = 'Awaiting import';
    $('status').textContent =
      'Imported copy and derived files deleted. Your original file is unchanged.';
    controls();
  } catch (error) {
    $('status').textContent = error.message;
  }
});
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'extraction.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
void refresh().catch(() => {
  $('status').textContent = 'Local server unavailable.';
});
setInterval(() => {
  if (running)
    void refresh().catch(() => {
      $('status').textContent = 'Connection interrupted. Reconnect to check the import.';
    });
}, 1000);
