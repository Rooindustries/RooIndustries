export const FINAL_RELEASE_TIMEOUT_PREFIX =
  "set lock_timeout = '5s';\nset statement_timeout = '120s';\n";

export const hasBoundedMigrationPrefix = (sql) =>
  String(sql || "").startsWith(FINAL_RELEASE_TIMEOUT_PREFIX);

export const extractGrantStatements = (sql) => Array.from(
  String(sql || "").matchAll(/(?:^|\n)\s*(grant\s+[\s\S]*?;)/gim),
  (match) => match[1].trim()
);

export const grantRecipients = (statement) => {
  const match = String(statement || "").match(/\bto\s+([^;]+)\s*;$/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((role) => role.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter(Boolean);
};

export const hasBrowserDataGrant = (sql) => extractGrantStatements(sql).some(
  (statement) => {
    if (!/^grant\s+(?:select|insert|update|delete|all)(?:\s+privileges)?\b/i.test(statement)) {
      return false;
    }
    const recipients = grantRecipients(statement);
    return recipients.includes("anon") || recipients.includes("authenticated");
  }
);

export const hasServiceRoleOnlyGrant = (sql, statementPattern) => {
  const matching = extractGrantStatements(sql).filter((statement) => {
    statementPattern.lastIndex = 0;
    return statementPattern.test(statement);
  });
  if (matching.length !== 1) return false;
  const recipients = grantRecipients(matching[0]);
  return recipients.length === 1 && recipients[0] === "service_role";
};
