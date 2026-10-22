"use client";

import ErrorPage from "./error";

export default function GlobalError({ error }) {
  return (
    <html lang="en">
      <body>
        <ErrorPage error={error} />
      </body>
    </html>
  );
}
