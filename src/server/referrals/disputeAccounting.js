const terminalStatuses = [
  'dispute_lost',
  'dispute_accepted',
  'dispute_expired',
];

export const isTerminalDisputeStatus = (status) =>
  terminalStatuses.includes(status);

export function resolveDisputeReferralAccounting(booking, record = {}) {
  const reversed = booking.dodoReferralReversedAfterDispute === true;
  const legacySkipped =
    !Object.hasOwn(booking, 'dodoReferralDisputeAccounted') &&
    booking.dodoReferralReversedAfterDispute === false &&
    booking.dodoDisputeActive === true &&
    (record.dodoDisputes || []).some((dispute) =>
      isTerminalDisputeStatus(dispute.status)
    );

  return {
    reversed,
    consumed:
      reversed ||
      booking.dodoReferralDisputeAccounted === true ||
      legacySkipped,
  };
}
