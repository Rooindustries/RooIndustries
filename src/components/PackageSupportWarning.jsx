export default function PackageSupportWarning({ className }) {
  return (
    <p className={className}>
      Refunds will not be issued in case you proceed with unsupported/custom parts.
      Please join the Discord and open a ticket or DM{" "}
      <span className="font-semibold">serviroo</span> to check for eligibility or
      switch to one of our other specialized plans.
    </p>
  );
}
