import { ancestors, calleeName, containsNode, enclosingComponent, memberName, propertyName } from "./util.mjs";

const isInitial = (name) => /^initial/.test(name);

const patternKey = (property) =>
  property?.computed && property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : propertyName(property);

const takesInitial = (pattern) =>
  pattern?.type === "ObjectPattern" && pattern.properties.some((property) => isInitial(patternKey(property)));

const bindsTo = (context, identifier, component) => {
  if (identifier?.type !== "Identifier") return false;
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable.defs.some((def) => def.type === "Parameter" && def.node === component);
  }
  return false;
};

const receivesInitialData = (context, component) => {
  const param = component.params[0];
  const props = param?.type === "AssignmentPattern" ? param.left : param;
  if (takesInitial(props)) return true;
  if (props?.type !== "Identifier") return false;
  const isProps = (node) =>
    node?.type === "Identifier" && node.name === props.name && bindsTo(context, node, component);
  return containsNode(
    component.body,
    (node) =>
      (node.type === "MemberExpression" && isProps(node.object) && isInitial(memberName(node))) ||
      (node.type === "VariableDeclarator" && isProps(node.init) && takesInitial(node.id)),
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Public CMS content loaded only in a mount effect never reaches the server-rendered page.",
    },
    messages: {
      clientOnly:
        "This content only loads after JavaScript runs. Pass it in from the server (an initial* prop) instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calleeName(node) !== "getPublicContent") return;
        const effect = [...ancestors(context, node)]
          .reverse()
          .find(
            (item) =>
              item.type === "CallExpression" && ["useEffect", "useLayoutEffect"].includes(calleeName(item)),
          );
        if (!effect) return;
        const deps = effect.arguments[1];
        if (!deps || deps.type !== "ArrayExpression" || deps.elements.length > 0) return;
        const component = enclosingComponent(context, node);
        if (component && receivesInitialData(context, component)) return;
        context.report({ node, messageId: "clientOnly" });
      },
    };
  },
};
