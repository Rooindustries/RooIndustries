import { ancestors, calleeName, containsNode, enclosingComponent, memberName, propertyName } from "./util.mjs";

const isInitial = (name) => /^initial/.test(name);

const takesInitial = (pattern) =>
  pattern?.type === "ObjectPattern" && pattern.properties.some((property) => isInitial(propertyName(property)));

const isProps = (node, props) => node?.type === "Identifier" && node.name === props.name;

const receivesInitialData = (component) => {
  const props = component.params[0];
  if (takesInitial(props)) return true;
  if (props?.type !== "Identifier") return false;
  return containsNode(
    component.body,
    (node) =>
      (node.type === "MemberExpression" && isProps(node.object, props) && isInitial(memberName(node))) ||
      (node.type === "VariableDeclarator" && isProps(node.init, props) && takesInitial(node.id)),
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
        if (component && receivesInitialData(component)) return;
        context.report({ node, messageId: "clientOnly" });
      },
    };
  },
};
