import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "vercel-api.json"), "utf8"));

export const TOKEN = "fixture-token-7f3a";
export const DOMAIN = "www.rooindustries.com";

const toSingleDeployment = (deployment, ownerId) => ({
  id: deployment.uid,
  url: deployment.url,
  name: deployment.name,
  createdAt: deployment.createdAt,
  ready: deployment.ready,
  readyState: deployment.readyState,
  readySubstate: deployment.readySubstate,
  target: deployment.target,
  projectId: deployment.projectId,
  ownerId,
  meta: deployment.meta,
  alias: [],
  aliasAssigned: deployment.readySubstate === "PROMOTED",
  aliasError: null,
});

export const startVercel = ({ tweak, rollbackError, freezeAlias, ignoreFilters, promoteStatus = 201 } = {}) => {
  const state = structuredClone(fixture);
  tweak?.(state);
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://fixture");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const notFound = () => send(404, { error: { code: "not_found", message: "The resource was not found" } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { error: { code: "forbidden", message: "Not authorized" } });
    const owned = url.searchParams.get("teamId") === state.project.accountId;
    const moveAlias = deploymentId => {
      if (!freezeAlias) state.aliases[DOMAIN].deploymentId = deploymentId;
    };
    let match;
    if (req.method === "GET" && url.pathname === "/v2/teams") {
      return send(200, { teams: state.teams, pagination: { count: state.teams.length, next: null, prev: null } });
    }
    if (req.method === "GET" && (match = url.pathname.match(/^\/v4\/aliases\/([^/]+)$/))) {
      const alias = owned ? state.aliases[decodeURIComponent(match[1])] : null;
      return alias ? send(200, alias) : notFound();
    }
    if (req.method === "GET" && (match = url.pathname.match(/^\/v13\/deployments\/([^/]+)$/))) {
      const key = decodeURIComponent(match[1]);
      const deployment = owned ? state.deployments.find(item => item.uid === key || item.url === key) : null;
      return deployment ? send(200, toSingleDeployment(deployment, state.project.accountId)) : notFound();
    }
    if (req.method === "GET" && (match = url.pathname.match(/^\/v9\/projects\/([^/]+)$/))) {
      return owned && decodeURIComponent(match[1]) === state.project.id ? send(200, state.project) : notFound();
    }
    if (req.method === "GET" && url.pathname === "/v7/deployments") {
      const query = url.searchParams;
      let list = owned ? [...state.deployments].sort((a, b) => b.created - a.created) : [];
      if (!ignoreFilters) {
        if (query.get("projectId")) list = list.filter(item => item.projectId === query.get("projectId"));
        if (query.get("target")) list = list.filter(item => item.target === query.get("target"));
        if (query.get("state")) list = list.filter(item => query.get("state").split(",").includes(item.readyState));
        if (query.get("rollbackCandidate")) list = list.filter(item => String(item.isRollbackCandidate) === query.get("rollbackCandidate"));
        if (query.get("until")) list = list.filter(item => item.created < Number(query.get("until")));
      }
      list = list.slice(0, Number(query.get("limit") || 20));
      return send(200, { deployments: list, pagination: { count: list.length, next: null, prev: null } });
    }
    if (req.method === "POST" && (match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/rollback\/([^/]+)$/))) {
      if (rollbackError) return send(rollbackError.status, { error: { code: rollbackError.code, message: rollbackError.message } });
      const from = state.aliases[DOMAIN].deploymentId;
      moveAlias(match[2]);
      state.project.autoAssignCustomDomains = false;
      state.project.lastAliasRequest = { type: "rollback", jobStatus: "succeeded", fromDeploymentId: from, toDeploymentId: match[2], requestedAt: Date.now() };
      return send(201);
    }
    if (req.method === "POST" && (match = url.pathname.match(/^\/v10\/projects\/([^/]+)\/promote\/([^/]+)$/))) {
      const from = state.aliases[DOMAIN].deploymentId;
      moveAlias(match[2]);
      state.project.autoAssignCustomDomains = true;
      state.project.lastAliasRequest = { type: "promote", jobStatus: "succeeded", fromDeploymentId: from, toDeploymentId: match[2], requestedAt: Date.now() };
      return send(promoteStatus);
    }
    return notFound();
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      state,
      requests,
      close: () => new Promise(done => server.close(done)),
    }));
  });
};
