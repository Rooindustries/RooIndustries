import { validateContentDocument } from "../lib/cms/contentSchema";

test.each(["a@.b.c", "a@b..c", "a@b."])("CMS refuses malformed owner email %s", (ownerEmail) => {
  expect(validateContentDocument("bookingSettings", { ownerEmail })).toEqual({
    ok: false,
    errors: [{ path: "$.ownerEmail", message: "A valid email is required." }],
  });
});

test.each(["user@exämple.de", "first.last+tag@sub.domain.com", "owner@example.invalid", "booking@roo.test"])("CMS accepts owner email %s", (ownerEmail) => {
  expect(validateContentDocument("bookingSettings", { ownerEmail })).toEqual({ ok: true, errors: [] });
});
