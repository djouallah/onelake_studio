'use strict';
// =============================================================================
// soap.js — XMLA's envelope: what Excel's provider sends, and the XML it takes back
// =============================================================================
// XMLA is SOAP over HTTP with two methods, Discover (metadata, as rowsets) and Execute (a
// statement). The requests come from one generator, MSOLAP, in plain XML (the connection string
// asks for it: Protocol Format=XML), so they are read by their elements, with no XML parser.
// =============================================================================

const NS = 'urn:schemas-microsoft-com:xml-analysis';

// A control character XML 1.0 has no place for, even escaped, in a value: one would make MSOLAP throw the
// whole answer away, so it shows as U+FFFD.
const esc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '\ufffd').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// A restriction is <Name>one</Name>, or <Name><Value>one</Value><Value>two</Value></Name>.
function restrictionsOf(text) {
  const list = (/<RestrictionList>([\s\S]*?)<\/RestrictionList>/.exec(text) || [])[1] || '';
  const out = {};
  for (const m of list.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    const values = [...m[2].matchAll(/<Value>([^<]*)<\/Value>/g)].map(v => unesc(v[1]));
    out[m[1]] = values.length ? values : [unesc(m[2])];
  }
  return out;
}

/** One request: { begin, end, sessionId, requestType (a Discover's), restrictions, catalog, statement (an Execute's) }. */
function parseRequest(text) {
  const props = (/<PropertyList>([\s\S]*?)<\/PropertyList>/.exec(text) || [])[1] || '';
  const statement = (/<Statement(?:\s[^>]*)?>([\s\S]*?)<\/Statement>/.exec(text) || [])[1];
  return {
    begin: /<BeginSession\b/.test(text),
    end: /<EndSession\b/.test(text),
    sessionId: (/<(?:Session|EndSession)\b[^>]*\bSessionId="([^"]+)"/.exec(text) || [])[1] || null,
    requestType: (/<RequestType>([^<]+)<\/RequestType>/.exec(text) || [])[1] || null,
    restrictions: restrictionsOf(text),
    catalog: (c => (c ? unesc(c[1]) : null))(/<Catalog>([^<]*)<\/Catalog>/.exec(props)),
    statement: statement == null ? null : unesc(statement),
  };
}

const envelope = (session, body) => '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
  (session ? `<soap:Header><Session xmlns="${NS}" SessionId="${esc(session)}"/></soap:Header>` : '') +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;

const discoverResponse = (session, root) =>
  envelope(session, `<DiscoverResponse xmlns="${NS}"><return>${root}</return></DiscoverResponse>`);
const executeResponse = (session, root) =>
  envelope(session, `<ExecuteResponse xmlns="${NS}"><return>${root}</return></ExecuteResponse>`);
const EMPTY_ROOT = `<root xmlns="${NS}:empty"/>`;

// Excel shows the description to whoever is at the pivot, so it says what happened in words.
const fault = (session, message) => envelope(session,
  `<soap:Fault><faultcode>XMLAnalysisError.0xc10e0002</faultcode><faultstring>${esc(message)}</faultstring>` +
  `<detail><Error ErrorCode="3238920194" Description="${esc(message)}" Source="OneLake Studio" HelpFile=""/></detail></soap:Fault>`);

// A rowset's columns as `name` or `name:type`, the type xsd's and string when left out.
const columns = spec => spec.trim().split(/\s+/).map(c => { const [n, t] = c.split(':'); return { name: n, type: t || 'string' }; });

const ROWSET_NS = `${NS}:rowset`;
const schemaOf = rowType => `<xsd:schema targetNamespace="${ROWSET_NS}" xmlns:sql="urn:schemas-microsoft-com:xml-sql" elementFormDefault="qualified">` +
  '<xsd:element name="root"><xsd:complexType><xsd:sequence minOccurs="0" maxOccurs="unbounded"><xsd:element name="row" type="row"/></xsd:sequence></xsd:complexType></xsd:element>' +
  `${rowType}</xsd:schema>`;
const rootOf = (rowType, rows) => `<root xmlns="${ROWSET_NS}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `${schemaOf(rowType)}${rows}</root>`;

const rowset = (cols, rows) => rootOf(
  `<xsd:complexType name="row"><xsd:sequence>${cols.map(c => `<xsd:element sql:field="${c.name}" name="${c.name}" type="xsd:${c.type}" minOccurs="0"/>`).join('')}</xsd:sequence></xsd:complexType>`,
  rows.map(r => `<row>${cols.filter(c => r[c.name] != null).map(c => `<${c.name}>${esc(r[c.name])}</${c.name}>`).join('')}</row>`).join(''));

// DISCOVER_SCHEMA_ROWSETS is the one rowset with a repeating column, and the provider goes no
// further until it reads as the server's own: a uuid type, Restrictions nested, a real mask.
const SCHEMA_ROWSETS_TYPE = '<xsd:simpleType name="uuid"><xsd:restriction base="xsd:string"><xsd:pattern value="[0-9a-zA-Z]{8}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{4}-[0-9a-zA-Z]{12}"/></xsd:restriction></xsd:simpleType>' +
  '<xsd:complexType name="row"><xsd:sequence>' +
  '<xsd:element sql:field="SchemaName" name="SchemaName" type="xsd:string" minOccurs="0"/>' +
  '<xsd:element sql:field="SchemaGuid" name="SchemaGuid" type="uuid" minOccurs="0"/>' +
  '<xsd:element sql:field="Restrictions" name="Restrictions" minOccurs="0" maxOccurs="unbounded"><xsd:complexType><xsd:sequence>' +
  '<xsd:element name="Name" type="xsd:string" sql:field="Name" minOccurs="0"/><xsd:element name="Type" type="xsd:string" sql:field="Type" minOccurs="0"/>' +
  '</xsd:sequence></xsd:complexType></xsd:element>' +
  '<xsd:element sql:field="Description" name="Description" type="xsd:string" minOccurs="0"/>' +
  '<xsd:element sql:field="RestrictionsMask" name="RestrictionsMask" type="xsd:unsignedLong" minOccurs="0"/>' +
  '</xsd:sequence></xsd:complexType>';
const schemaRowsets = list => rootOf(SCHEMA_ROWSETS_TYPE, list.map(s =>
  `<row><SchemaName>${s.name}</SchemaName><SchemaGuid>${s.guid}</SchemaGuid>` +
  s.restrictions.map(r => `<Restrictions><Name>${r.name}</Name><Type>${r.type}</Type></Restrictions>`).join('') +
  `<RestrictionsMask>${(2 ** s.restrictions.length) - 1}</RestrictionsMask></row>`).join(''));

module.exports = { esc, unesc, parseRequest, envelope, discoverResponse, executeResponse, EMPTY_ROOT, fault, columns, rowset, schemaRowsets };
