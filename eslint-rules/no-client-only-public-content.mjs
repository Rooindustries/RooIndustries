import { ancestors, calleeName, enclosingComponent } from "./util.mjs";

const receivesInitialData = (component) => {
  const props = component.params[0];
  if (!props) return false;
  if (props.type === "ObjectPattern") {
    return props.properties.some(
      (property) =>
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        /^initial/.test(property.key.name),
    );
  }
  return props.type === "Identifier";
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
