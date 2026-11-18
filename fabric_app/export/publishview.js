'use strict';
// =============================================================================
// publishview.js — Fabric's Publish of a semantic view, as the tree's ▶ on a view's folder asks it
// =============================================================================
// A lakehouse's semantic views are YAML in <lakehouse>/Context/Semantic Views/<view>/. Fabric's Publish compiles
// one into TMDL (SystemContext/Semantic Views/<view>/) and the read-only Direct Lake model of the view's name:
// https://learn.microsoft.com/en-us/fabric/fundamentals/semantic-views-publish. Studio asks for it and reports
// what Fabric said; the compiling is Fabric's. The API is a beta one: POST …/semanticViews/<view>/publish?beta=true,
// answered when it is done (200), or as a long-running operation (202).
// =============================================================================

const { FABRIC_API, authedFetch, jsonOrText, waitFabricOperation } = require('../../core/onelake/http');

const TIMEOUT_MS = 5 * 60_000;

// One of Fabric's diagnostics as a line: its severity, code and message, and where in which file.
function diagnosticLine(d) {
  const at = d.source && d.source.path
    ? `(${d.source.path}${d.source.start ? `, line ${d.source.start.line}` : ''}${d.source.semanticPath ? `, ${d.source.semanticPath}` : ''})`
    : '';
  return [d.severity, d.code, d.message, at, d.messageArguments ? JSON.stringify(d.messageArguments) : ''].filter(Boolean).join(' ');
}

/**
 * @param {object} o
 * @param {object} o.fabric  core/models/fabric.js: workspaceId, listItems
 * @param {(o?: {fresh?: boolean}) => Promise<string|null>} o.getToken  Fabric API audience
 */
function createViewPublisher({ fabric, getToken, apiBase = FABRIC_API, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const call = (url, init = {}) => authedFetch(url, { getToken, timeoutMs: TIMEOUT_MS, who: 'the Fabric API', ...init });

  /**
   * Publish the view `view` of `lakehouse` (its name) in `workspace` (its name): { modelId, warnings }. A failure
   * throws, with Fabric's diagnostics (`diagnostics`, one line each, by file and line).
   */
  async function publish(workspace, lakehouse, view) {
    const wsId = await fabric.workspaceId(workspace);
    const lh = (await fabric.listItems(workspace))
      .find(i => i.type === 'Lakehouse' && i.name.toLowerCase() === String(lakehouse).toLowerCase());
    if (!lh) throw new Error(`The Fabric API does not list a lakehouse named ${lakehouse} in ${workspace}`);
    const r = await call(`${apiBase}/workspaces/${wsId}/lakehouses/${lh.id}/semanticViews/${encodeURIComponent(view)}/publish?beta=true`,
      { method: 'POST', headers: { 'content-length': '0' } });
    if (r.status === 202) {
      await waitFabricOperation(r, `Publishing ${view}`, { call: u => call(u), sleep, waitMs: 3000, polls: 100 });
      return { modelId: null, warnings: [] };
    }
    const body = await jsonOrText(r);
    if (!r.ok) {
      // Fabric's diagnostics are JSON in a string, in moreDetails.
      const diagnostics = [];
      for (const m of (body && body.moreDetails) || []) {
        try { diagnostics.push(...(JSON.parse(m.message).diagnostics || []).map(diagnosticLine)); }
        catch (_) { if (m && m.message) diagnostics.push(String(m.message)); }
      }
      const why = diagnostics.length ? diagnostics.join('\n')
        : (body && (body.message || body.errorCode)) || (typeof body === 'string' && body) || `HTTP ${r.status}`;
      throw Object.assign(new Error(`Fabric did not publish ${view} (HTTP ${r.status}): ${why}`), { status: r.status, diagnostics });
    }
    return {
      modelId: (body && body.semanticModel && body.semanticModel.id) || null,
      warnings: ((body && body.warnings) || []).map(w => (typeof w === 'string' ? w : diagnosticLine(w))),
    };
  }

  return { publish };
}

module.exports = { createViewPublisher, diagnosticLine };
