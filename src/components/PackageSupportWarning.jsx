const BOX_CLASS = [
  "mx-auto mb-6 rounded-xl border border-warning-border bg-surface-card px-5 py-4",
  "text-left text-base leading-relaxed text-warning-text",
].join(" ");

export default function PackageSupportWarning({ widthClass }) {
  return (
    <p className={`${BOX_CLASS} ${widthClass}`}>
      Refunds will not be issued in case you proceed with unsupported/custom parts.
      Please join the Discord and open a ticket or DM{" "}
      <span className="font-semibold">serviroo</span> to check for eligibility or
      switch to one of our other specialized plans.
    </p>
  );
}
