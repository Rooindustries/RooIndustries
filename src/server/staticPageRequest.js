import { AppPageRouteModule } from "next/dist/server/route-modules/app-page/module.compiled";
import routes from "../lib/routes";

const installed = Symbol.for("roo.staticPageRequest");
const prebuiltRoutes = new Set(routes.PREBUILT_ROUTES);

export const normalizeStaticPageRequests = () => {
  const prototype = AppPageRouteModule.prototype;
  if (prototype[installed]) return;
  const render = prototype.render;
  prototype.render = function (request, response, context) {
    if (!["GET", "HEAD"].includes(request.method) || context.renderOpts.supportsDynamicResponse || !prebuiltRoutes.has(this.definition.pathname)) {
      return render.call(this, request, response, context);
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const staticRequest = new Proxy(request, {
      get(target, property, receiver) {
        return property === "url" ? pathname : Reflect.get(target, property, receiver);
      },
    });
    return render.call(this, staticRequest, response, context);
  };
  Object.defineProperty(prototype, installed, { value: true });
};
