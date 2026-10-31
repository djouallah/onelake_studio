'use strict';
// =============================================================================
// title.js — what the sidebar's header and the panel's tab say about this window
// =============================================================================
// Always OneLake Studio, and where it reads from: offline, or the tenant in use. The tenant is the
// one the onelakeStudio.tenantId setting names, since a guest's own domain would name the wrong
// tenant; with no setting, the home tenant, which is the account's domain.
//
// No `vscode` import: driven from tests.
// =============================================================================

const NAME = 'OneLake Studio';

function placeOf({ offline, account, tenant }) {
  if (offline) return 'offline';
  if (tenant) return tenant;
  const label = String(account || '');
  return label.slice(label.lastIndexOf('@') + 1);
}

const tabTitle = place => (place ? `${NAME}: ${place}` : NAME);

module.exports = { NAME, placeOf, tabTitle };
