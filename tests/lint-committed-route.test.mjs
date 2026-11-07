import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("react-hooks/refs", reactHooks.rules.refs, {
  valid: [
    `function Navigation({ location }) {
      const locationRef = useRef(location);
      useLayoutEffect(() => { locationRef.current = location; }, [location]);
      return null;
    }`,
  ],
  invalid: [
    {
      code: `function Navigation({ location }) {
        const locationRef = useRef(location);
        locationRef.current = location;
        return null;
      }`,
      errors: [{ message: /Cannot access refs during render/ }],
    },
  ],
});
