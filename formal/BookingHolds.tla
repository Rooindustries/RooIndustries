---------------------------- MODULE BookingHolds ----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Tabs, Slots, HoldMinutes, Backstop, MaxTime, MaxNonce, MaxRetries

NoSlot == "no_slot"
NoNonce == 0
DeadNonce == MaxNonce + 1
RestoredId == MaxNonce + 2
Nonces == 1..MaxNonce
Horizon == MaxTime + HoldMinutes + Backstop
Times == 0..Horizon
LivePhases == {"active", "holding", "payment_pending"}
CommitPhases == {"active", "payment_pending"}

VARIABLES now, nextNonce, hold, lock, tab, rec, bookings

vars == <<now, nextNonce, hold, lock, tab, rec, bookings>>

TabPermutations == Permutations(Tabs)

EmptyHold == [phase |-> "none", nonce |-> NoNonce, exp |-> 0, rec |-> NoNonce,
              failures |-> 0, retainedAfterExpiry |-> FALSE]
EmptyTab == [slot |-> NoSlot, nonce |-> NoNonce, exp |-> 0, details |-> FALSE, paying |-> NoNonce]
EmptyRec == [status |-> "none", slot |-> NoSlot, tokenExp |-> 0, created |-> 0,
             pay |-> "open", paidInTime |-> FALSE, details |-> FALSE, knownCaptured |-> FALSE, terminal |-> FALSE,
             outlived |-> FALSE, valid |-> TRUE, retainRead |-> FALSE,
             failedObserved |-> FALSE, abandonedObserved |-> FALSE,
             lateCaptureClaimed |-> FALSE, claimInFlight |-> FALSE, crashedAfterClaim |-> FALSE]

TypeOK ==
  /\ now \in Times
  /\ nextNonce \in 1..(MaxNonce + 1)
  /\ hold \in [Slots -> [phase : {"none", "released", "consumed", "expired"} \cup LivePhases,
                         nonce : 0..DeadNonce, exp : Times, rec : 0..MaxNonce,
                         failures : 0..MaxRetries, retainedAfterExpiry : BOOLEAN]]
  /\ lock \in [Slots -> 0..RestoredId]
  /\ tab \in [Tabs -> [slot : Slots \cup {NoSlot}, nonce : 0..MaxNonce, exp : Times,
                       details : BOOLEAN, paying : 0..MaxNonce]]
  /\ rec \in [Nonces -> [status : {"none", "started", "needs_recovery", "booked", "rescheduled", "abandoned", "failed"},
                         slot : Slots \cup {NoSlot}, tokenExp : Times, created : Times,
                         pay : {"open", "processing", "captured", "failed", "closed"},
                         paidInTime : BOOLEAN, details : BOOLEAN, knownCaptured : BOOLEAN, terminal : BOOLEAN,
                         outlived : BOOLEAN, valid : BOOLEAN, retainRead : BOOLEAN,
                         failedObserved : BOOLEAN, abandonedObserved : BOOLEAN,
                         lateCaptureClaimed : BOOLEAN, claimInFlight : BOOLEAN, crashedAfterClaim : BOOLEAN]]

Init ==
  /\ now = 0
  /\ nextNonce = 1
  /\ hold = [s \in Slots |-> EmptyHold]
  /\ lock = [s \in Slots |-> 0]
  /\ tab = [t \in Tabs |-> EmptyTab]
  /\ rec = [n \in Nonces |-> EmptyRec]
  /\ bookings = {}

VisitorsActive == now <= MaxTime

HoldIsActive(h) == h.phase \in LivePhases /\ h.exp > now

HoldOwnsSlot(h) == h.phase = "payment_pending" \/ HoldIsActive(h)

TokenOwns(tk, s) == tk.slot = s /\ tk.nonce = hold[s].nonce /\ tk.exp > now

BookingFor(n) == {b \in bookings : b.id = n}

SlotBookings(s) == {b \in bookings : b.slot = s}

ReleasedHold(h) == [h EXCEPT !.phase = "released", !.nonce = DeadNonce, !.exp = now, !.rec = NoNonce, !.retainedAfterExpiry = FALSE]

PaymentReleasedHold(h) == [h EXCEPT !.phase = "released", !.exp = now, !.rec = NoNonce, !.retainedAfterExpiry = FALSE]

ConsumedHold(h) == [h EXCEPT !.phase = "consumed", !.exp = now, !.retainedAfterExpiry = FALSE]

HoldSlot(t, s) ==
  LET tk == tab[t]
      h == hold[s]
      prev == tk.slot
      movingFromPendingPayment ==
        prev \notin {NoSlot, s} /\ TokenOwns(tk, prev) /\ hold[prev].phase = "payment_pending"
      releasePrevious ==
        prev \notin {NoSlot, s} /\ TokenOwns(tk, prev) /\ hold[prev].phase # "payment_pending"
      keptFailures == IF HoldOwnsSlot(h) /\ TokenOwns(tk, s) THEN h.failures ELSE 0
      granted == [phase |-> "active", nonce |-> nextNonce, exp |-> now + HoldMinutes,
                  rec |-> NoNonce, failures |-> keptFailures, retainedAfterExpiry |-> FALSE]
  IN /\ VisitorsActive
     /\ nextNonce <= MaxNonce
     /\ ~movingFromPendingPayment
     /\ lock[s] = 0
     /\ HoldOwnsSlot(h) => (h.phase # "payment_pending" /\ TokenOwns(tk, s))
     /\ hold' = IF releasePrevious
                  THEN [hold EXCEPT ![s] = granted, ![prev] = ReleasedHold(hold[prev])]
                  ELSE [hold EXCEPT ![s] = granted]
     /\ tab' = [tab EXCEPT ![t].slot = s, ![t].nonce = nextNonce, ![t].exp = now + HoldMinutes,
                           ![t].paying = NoNonce]
     /\ nextNonce' = nextNonce + 1
     /\ UNCHANGED <<now, lock, rec, bookings>>

ReleaseHold(t) ==
  LET s == tab[t].slot
  IN /\ VisitorsActive
     /\ s # NoSlot
     /\ TokenOwns(tab[t], s)
     /\ hold[s].phase # "payment_pending"
     /\ hold' = [hold EXCEPT ![s] = ReleasedHold(hold[s])]
     /\ tab' = [tab EXCEPT ![t].slot = NoSlot, ![t].nonce = NoNonce, ![t].exp = 0, ![t].paying = NoNonce]
     /\ UNCHANGED <<now, nextNonce, lock, rec, bookings>>

TypeDetails(t) ==
  /\ VisitorsActive
  /\ tab[t].slot # NoSlot
  /\ ~tab[t].details
  /\ tab' = [tab EXCEPT ![t].details = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, rec, bookings>>

DuplicateTab(from, to) ==
  /\ VisitorsActive
  /\ from # to
  /\ tab[to] = EmptyTab
  /\ tab[from].slot # NoSlot
  /\ tab' = [tab EXCEPT ![to] = tab[from]]
  /\ UNCHANGED <<now, nextNonce, hold, lock, rec, bookings>>

StartPayment(t) ==
  LET tk == tab[t]
      s == tk.slot
      n == tk.nonce
  IN /\ VisitorsActive
     /\ s # NoSlot
     /\ hold[s].phase # "none"
     /\ ~(hold[s].exp <= now /\ hold[s].phase # "payment_pending")
     /\ TokenOwns(tk, s)
     /\ IF rec[n].status # "none"
          THEN /\ tab' = [tab EXCEPT ![t].exp = rec[n].tokenExp, ![t].paying = n]
               /\ UNCHANGED <<hold, rec>>
          ELSE /\ tk.details
               /\ rec' = [rec EXCEPT ![n] = [EmptyRec EXCEPT !.status = "started", !.slot = s,
                                              !.tokenExp = now + HoldMinutes, !.created = now,
                                              !.details = TRUE]]
               /\ hold' = [hold EXCEPT ![s].phase = "payment_pending", ![s].rec = n,
                                       ![s].exp = now + HoldMinutes, ![s].retainedAfterExpiry = FALSE]
               /\ tab' = [tab EXCEPT ![t].exp = now + HoldMinutes, ![t].paying = n]
     /\ UNCHANGED <<now, nextNonce, lock, bookings>>

CancelPayment(t) ==
  LET n == tab[t].paying
      s == rec[n].slot
  IN /\ VisitorsActive
     /\ n # NoNonce
     /\ rec[n].status = "started"
     /\ rec[n].pay = "open"
     /\ hold[s].rec = n
     /\ IF hold[s].exp > now
          THEN /\ nextNonce <= MaxNonce
               /\ hold' = [hold EXCEPT ![s].phase = "holding", ![s].nonce = nextNonce, ![s].rec = NoNonce, ![s].retainedAfterExpiry = FALSE]
               /\ tab' = [tab EXCEPT ![t].nonce = nextNonce, ![t].exp = hold[s].exp, ![t].paying = NoNonce]
               /\ nextNonce' = nextNonce + 1
          ELSE /\ hold' = [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])]
               /\ tab' = [tab EXCEPT ![t].paying = NoNonce]
               /\ UNCHANGED nextNonce
     /\ rec' = [rec EXCEPT ![n].status = "abandoned", ![n].abandonedObserved = TRUE]
     /\ UNCHANGED <<now, lock, bookings>>

SubmitPayment(n) ==
  LET s == rec[n].slot
  IN /\ VisitorsActive
     /\ rec[n].status # "none"
     /\ rec[n].pay = "open"
     /\ rec' = [rec EXCEPT ![n].pay = "processing",
                           ![n].paidInTime = (hold[s].phase = "payment_pending" /\ hold[s].rec = n
                                              /\ hold[s].exp > now)]
     /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

PaymentSucceeds(n) ==
  /\ rec[n].pay = "processing"
  /\ \E valid \in BOOLEAN : rec' = [rec EXCEPT ![n].pay = "captured", ![n].valid = valid]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

PaymentFails(n) ==
  /\ rec[n].pay = "processing"
  /\ rec' = [rec EXCEPT ![n].pay = IF MaxRetries > 0 THEN "failed" ELSE "open"]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

LateCaptureAfterFailure(n) ==
  /\ MaxRetries > 0
  /\ rec[n].pay = "failed"
  /\ rec[n].status \in {"failed", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ rec' = [rec EXCEPT ![n].pay = "captured", ![n].valid = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

FailReadRetainEligible(n) ==
  LET s == rec[n].slot
  IN /\ MaxRetries > 0
     /\ rec[n].pay = "failed"
     /\ rec[n].status \in {"started", "needs_recovery"}
     /\ ~rec[n].retainRead
     /\ ~rec[n].knownCaptured
     /\ ~rec[n].terminal
     /\ hold[s].phase = "payment_pending"
     /\ hold[s].rec = n
     /\ hold[s].exp > now
     /\ hold[s].failures < MaxRetries
     /\ rec' = [rec EXCEPT ![n].retainRead = TRUE]
     /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

FailCommitRetain(n) ==
  LET s == rec[n].slot
  IN /\ MaxRetries > 0
     /\ rec[n].pay = "failed"
     /\ rec[n].status \in {"started", "needs_recovery"}
     /\ rec[n].retainRead
     /\ ~rec[n].knownCaptured
     /\ ~rec[n].terminal
     /\ hold[s].phase = "payment_pending"
     /\ hold[s].rec = n
     /\ hold[s].failures < MaxRetries
     /\ nextNonce <= MaxNonce
     /\ hold' = [hold EXCEPT ![s].phase = "active", ![s].nonce = nextNonce,
                             ![s].rec = NoNonce, ![s].failures = hold[s].failures + 1,
                             ![s].retainedAfterExpiry = (hold[s].exp <= now)]
     /\ tab' = [t \in Tabs |->
          IF tab[t].paying = n
            THEN [tab[t] EXCEPT !.nonce = nextNonce, !.exp = hold[s].exp, !.paying = NoNonce]
            ELSE tab[t]]
     /\ rec' = [rec EXCEPT ![n].status = "failed", ![n].failedObserved = TRUE,
                           ![n].retainRead = FALSE, ![n].paidInTime = FALSE]
     /\ nextNonce' = nextNonce + 1
     /\ UNCHANGED <<now, lock, bookings>>

FailReleaseHold(n) ==
  LET s == rec[n].slot
  IN /\ MaxRetries > 0
     /\ rec[n].pay = "failed"
     /\ rec[n].status \in {"started", "needs_recovery"}
     /\ ~rec[n].knownCaptured
     /\ ~rec[n].terminal
     /\ (hold[s].rec # n \/ hold[s].exp <= now \/ hold[s].failures >= MaxRetries \/ nextNonce > MaxNonce)
     /\ hold' = IF hold[s].rec = n THEN [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])] ELSE hold
     /\ tab' = [t \in Tabs |-> IF tab[t].paying = n THEN [tab[t] EXCEPT !.paying = NoNonce] ELSE tab[t]]
     /\ rec' = [rec EXCEPT ![n].status = "failed", ![n].failedObserved = TRUE,
                           ![n].retainRead = FALSE, ![n].paidInTime = FALSE]
     /\ UNCHANGED <<now, nextNonce, lock, bookings>>

PendingVetoFailure(n) ==
  /\ MaxRetries > 0
  /\ rec[n].pay = "processing"
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ ~rec[n].failedObserved
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery", ![n].failedObserved = TRUE, ![n].paidInTime = FALSE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

PendingVetoAbandonment(n) ==
  /\ MaxRetries > 0
  /\ rec[n].pay = "processing"
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ ~rec[n].abandonedObserved
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery", ![n].abandonedObserved = TRUE, ![n].paidInTime = FALSE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

CheckoutExpires(n) ==
  LET s == rec[n].slot
  IN /\ rec[n].status \in {"started", "needs_recovery", "abandoned"}
     /\ rec[n].pay = "open"
     /\ rec' = [rec EXCEPT ![n].pay = "closed", ![n].status = "abandoned", ![n].abandonedObserved = TRUE]
     /\ hold' = IF rec[n].status \in {"started", "needs_recovery"} /\ hold[s].rec = n
                  THEN [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])]
                  ELSE hold
     /\ UNCHANGED <<now, nextNonce, lock, tab, bookings>>

CommitState(n) ==
  LET s == rec[n].slot
      h == hold[s]
      signed == h.nonce = n /\ rec[n].tokenExp > now
      activeHold == h.phase \in CommitPhases /\ h.exp > now
  IN IF signed THEN "hold_active"
     ELSE IF h.nonce = n /\ ~activeHold /\ h.exp <= now THEN "reconciled_after_expired_hold"
     ELSE "rejected"

CanCommit(n) ==
  LET s == rec[n].slot
      h == hold[s]
      state == CommitState(n)
  IN /\ state # "rejected"
     /\ lock[s] = 0
     /\ SlotBookings(s) = {}
     /\ h.phase \in CommitPhases
     /\ (state = "reconciled_after_expired_hold" \/ h.exp > now)
     /\ (h.phase = "payment_pending" => h.rec = n)

Snapshot(n) ==
  LET h == hold[rec[n].slot]
  IN [phase |-> h.phase, nonce |-> h.nonce, rec |-> h.rec, live |-> h.exp > now]

CommitBooking(n) ==
  LET s == rec[n].slot
  IN /\ bookings' = bookings \cup {[id |-> n, slot |-> s, kind |-> "slot", hold |-> Snapshot(n),
                                    paidInTime |-> rec[n].paidInTime]}
     /\ lock' = [lock EXCEPT ![s] = n]
     /\ hold' = [hold EXCEPT ![s] = ConsumedHold(hold[s])]
     /\ rec' = [rec EXCEPT ![n].status = "booked", ![n].claimInFlight = FALSE]

RecordReschedule(n) ==
  LET s == rec[n].slot
  IN /\ bookings' = IF BookingFor(n) = {}
                      THEN bookings \cup {[id |-> n, slot |-> NoSlot, kind |-> "reschedule",
                                           hold |-> Snapshot(n), paidInTime |-> rec[n].paidInTime]}
                      ELSE bookings
     /\ hold' = IF hold[s].rec = n THEN [hold EXCEPT ![s] = ConsumedHold(hold[s])] ELSE hold
     /\ rec' = [rec EXCEPT ![n].status = IF BookingFor(n) = {} THEN "rescheduled" ELSE "booked",
                           ![n].claimInFlight = FALSE]
     /\ UNCHANGED lock

MarkNeedsRecovery(n) ==
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery",
                          ![n].knownCaptured = rec[n].knownCaptured \/ rec[n].pay = "captured",
                          ![n].failedObserved = rec[n].failedObserved \/ rec[n].status = "failed",
                          ![n].abandonedObserved = rec[n].abandonedObserved \/ rec[n].status = "abandoned"]
  /\ UNCHANGED <<hold, lock, bookings>>

ClaimLateCapture(n) ==
  /\ rec[n].pay = "captured"
  /\ rec[n].valid
  /\ ~rec[n].knownCaptured
  /\ ~rec[n].terminal
  /\ (rec[n].status \in {"failed", "abandoned"}
      \/ (rec[n].status = "needs_recovery" /\ (rec[n].failedObserved \/ rec[n].abandonedObserved)))
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery",
                        ![n].knownCaptured = TRUE,
                        ![n].lateCaptureClaimed = TRUE,
                        ![n].claimInFlight = TRUE,
                        ![n].failedObserved = rec[n].failedObserved \/ rec[n].status = "failed",
                        ![n].abandonedObserved = rec[n].abandonedObserved \/ rec[n].status = "abandoned"]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

CrashAfterLateCaptureClaim(n) ==
  /\ rec[n].status = "needs_recovery"
  /\ rec[n].knownCaptured
  /\ rec[n].lateCaptureClaimed
  /\ rec[n].claimInFlight
  /\ rec' = [rec EXCEPT ![n].claimInFlight = FALSE, ![n].crashedAfterClaim = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

FinalizeCapture(n) ==
  /\ rec[n].pay = "captured"
  /\ rec[n].valid
  /\ ~rec[n].terminal
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ IF rec[n].failedObserved \/ rec[n].abandonedObserved
       THEN /\ rec[n].lateCaptureClaimed
            /\ rec[n].claimInFlight
            /\ RecordReschedule(n)
     ELSE IF BookingFor(n) # {}
       THEN /\ rec' = [rec EXCEPT ![n].status = "booked"]
            /\ UNCHANGED <<hold, lock, bookings>>
     ELSE IF CanCommit(n)
       THEN CommitBooking(n)
     ELSE MarkNeedsRecovery(n)
  /\ UNCHANGED <<now, nextNonce, tab>>

ReconcileRecovery(n) ==
  /\ rec[n].pay = "captured"
  /\ rec[n].valid
  /\ ~rec[n].terminal
  /\ rec[n].status = "needs_recovery"
  /\ IF rec[n].failedObserved \/ rec[n].abandonedObserved
       THEN /\ rec[n].lateCaptureClaimed
            /\ ~rec[n].claimInFlight
            /\ RecordReschedule(n)
     ELSE IF CanCommit(n) THEN CommitBooking(n) ELSE RecordReschedule(n)
  /\ UNCHANGED <<now, nextNonce, tab>>

ReconcilePending(n) ==
  /\ rec[n].pay = "processing"
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery"]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

ReconcileUnpaid(n) ==
  LET s == rec[n].slot
  IN /\ rec[n].status \in {"started", "needs_recovery"}
     /\ ~rec[n].terminal
     /\ rec[n].pay \in {"open", "closed"}
     /\ now >= rec[n].created + HoldMinutes
     /\ rec' = [rec EXCEPT ![n].status = "abandoned", ![n].abandonedObserved = TRUE]
     /\ hold' = IF hold[s].rec = n THEN [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])] ELSE hold
     /\ UNCHANGED <<now, nextNonce, lock, tab, bookings>>

CleanupExpiredHold(s) ==
  /\ hold[s].phase \in {"active", "holding"}
  /\ hold[s].exp <= now
  /\ hold' = [hold EXCEPT ![s].phase = "expired", ![s].nonce = DeadNonce, ![s].retainedAfterExpiry = FALSE]
  /\ UNCHANGED <<now, nextNonce, lock, tab, rec, bookings>>

RecoveryGivesUp(n) ==
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ \E observed \in BOOLEAN :
       rec' = [rec EXCEPT ![n].terminal = TRUE,
                            ![n].knownCaptured = observed /\ rec[n].pay = "captured"]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

ReconcileRejectsCapture(n) ==
  /\ rec[n].pay = "captured"
  /\ ~rec[n].valid
  /\ ~rec[n].terminal
  /\ rec[n].status \in {"started", "needs_recovery", "abandoned", "failed"}
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery", ![n].terminal = TRUE, ![n].knownCaptured = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

WebhookRecordsCapture(n) ==
  /\ rec[n].terminal
  /\ rec[n].pay = "captured"
  /\ ~rec[n].knownCaptured
  /\ rec' = [rec EXCEPT ![n].knownCaptured = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

OwnerRefundsUnbookedCapture(n) ==
  /\ rec[n].terminal
  /\ rec[n].pay = "captured"
  /\ BookingFor(n) = {}
  /\ rec' = [rec EXCEPT ![n].pay = "closed", ![n].knownCaptured = FALSE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

AdminRestoresBooking(s) ==
  /\ lock[s] = 0
  /\ SlotBookings(s) = {}
  /\ ~HoldOwnsSlot(hold[s])
  /\ bookings' = bookings \cup {[id |-> RestoredId, slot |-> s, kind |-> "restored",
                                    hold |-> [phase |-> hold[s].phase, nonce |-> hold[s].nonce,
                                              rec |-> hold[s].rec, live |-> hold[s].exp > now],
                                    paidInTime |-> FALSE]}
  /\ lock' = [lock EXCEPT ![s] = RestoredId]
  /\ hold' = [hold EXCEPT ![s] = ConsumedHold(hold[s])]
  /\ UNCHANGED <<now, nextNonce, tab, rec>>

UnconfirmedPaymentHoldExpires(s) ==
  /\ hold[s].phase = "payment_pending"
  /\ hold[s].exp + Backstop <= now
  /\ ~rec[hold[s].rec].knownCaptured
  /\ hold' = [hold EXCEPT ![s].phase = "expired", ![s].nonce = DeadNonce, ![s].retainedAfterExpiry = FALSE]
  /\ rec' = [rec EXCEPT ![hold[s].rec].outlived =
                rec[hold[s].rec].pay \in {"processing", "captured"} /\ ~rec[hold[s].rec].knownCaptured]
  /\ UNCHANGED <<now, nextNonce, lock, tab, bookings>>

Tick ==
  /\ now < Horizon
  /\ now' = now + 1
  /\ UNCHANGED <<nextNonce, hold, lock, tab, rec, bookings>>

Next ==
  \/ Tick
  \/ \E s \in Slots : CleanupExpiredHold(s)
  \/ \E s \in Slots : AdminRestoresBooking(s) \/ UnconfirmedPaymentHoldExpires(s)
  \/ \E t \in Tabs : \/ ReleaseHold(t) \/ TypeDetails(t) \/ StartPayment(t) \/ CancelPayment(t)
                     \/ \E s \in Slots : HoldSlot(t, s)
                     \/ \E u \in Tabs : DuplicateTab(t, u)
  \/ \E n \in Nonces : \/ SubmitPayment(n) \/ PaymentSucceeds(n) \/ PaymentFails(n) \/ CheckoutExpires(n)
                       \/ ClaimLateCapture(n) \/ CrashAfterLateCaptureClaim(n)
                       \/ FinalizeCapture(n) \/ ReconcileRecovery(n) \/ ReconcilePending(n)
                       \/ ReconcileUnpaid(n) \/ RecoveryGivesUp(n) \/ WebhookRecordsCapture(n)
                       \/ OwnerRefundsUnbookedCapture(n) \/ ReconcileRejectsCapture(n)
                       \/ LateCaptureAfterFailure(n) \/ FailReadRetainEligible(n) \/ FailCommitRetain(n)
                       \/ FailReleaseHold(n) \/ PendingVetoFailure(n) \/ PendingVetoAbandonment(n)

Server(n) == ClaimLateCapture(n) \/ FinalizeCapture(n) \/ ReconcileRecovery(n) \/ ReconcilePending(n)
             \/ ReconcileUnpaid(n) \/ WebhookRecordsCapture(n) \/ ReconcileRejectsCapture(n)
             \/ FailReadRetainEligible(n) \/ FailCommitRetain(n) \/ FailReleaseHold(n)

RetryHoldSlot(t, s) ==
  /\ ~HoldOwnsSlot(hold[s])
  /\ (hold[s].phase = "none"
      \/ (hold[s].phase \in {"active", "expired"} /\ tab[t].slot = NoSlot)
      \/ (hold[s].phase = "released" /\ hold[s].failures = MaxRetries /\ tab[t].slot = s))
  /\ HoldSlot(t, s)

RetryLateCapture(n) ==
  /\ \A m \in Nonces : ~(rec[m].failedObserved /\ rec[m].pay = "captured")
  /\ \A m \in 1..(n - 1) : ~rec[m].failedObserved
  /\ LateCaptureAfterFailure(n)

RetryPendingVeto(n) ==
  /\ n = 1
  /\ rec[n].slot # NoSlot
  /\ hold[rec[n].slot].rec = n
  /\ \A m \in Nonces : ~rec[m].failedObserved /\ ~rec[m].abandonedObserved
  /\ (PendingVetoFailure(n) \/ PendingVetoAbandonment(n))

RetryNext ==
  \/ Tick
  \/ \E s \in Slots : CleanupExpiredHold(s) \/ UnconfirmedPaymentHoldExpires(s)
  \/ \E t \in Tabs : \/ TypeDetails(t) \/ StartPayment(t)
                     \/ (nextNonce = 2 /\ tab[t].slot # NoSlot /\ hold[tab[t].slot].failures = 0
                         /\ CancelPayment(t))
                     \/ \E s \in Slots : RetryHoldSlot(t, s)
  \/ \E n \in Nonces : \/ SubmitPayment(n) \/ PaymentFails(n)
                       \/ (rec[n].pay = "processing"
                           /\ rec' = [rec EXCEPT ![n].pay = "captured", ![n].valid = TRUE]
                           /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>)
                       \/ RetryLateCapture(n) \/ FailReadRetainEligible(n) \/ FailCommitRetain(n)
                       \/ FailReleaseHold(n) \/ RetryPendingVeto(n)
                       \/ ClaimLateCapture(n) \/ CrashAfterLateCaptureClaim(n)
                       \/ FinalizeCapture(n) \/ ReconcileRecovery(n)
                       \/ (n = 1 /\ ReconcileUnpaid(n))

RetrySpec == Init /\ [][RetryNext]_vars /\ WF_vars(Tick) /\ \A n \in Nonces : WF_vars(Server(n))
               /\ \A s \in Slots : WF_vars(UnconfirmedPaymentHoldExpires(s))

Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ \A n \in Nonces : WF_vars(Server(n)) /\ SF_vars(CheckoutExpires(n))
          /\ \A s \in Slots : WF_vars(UnconfirmedPaymentHoldExpires(s))

OneHoldPerSlotStart ==
  \A s \in Slots :
    /\ hold[s].phase = "payment_pending" => hold[s].rec = hold[s].nonce
    /\ Cardinality({n \in Nonces : hold[s].phase = "payment_pending" /\ hold[s].rec = n}) <= 1

NoSecondHoldOverLiveHold ==
  [][\A s \in Slots :
       (hold'[s].nonce # hold[s].nonce /\ hold'[s].phase = "active" /\ HoldOwnsSlot(hold[s]))
         => \/ /\ hold[s].phase # "payment_pending"
               /\ \E u \in Tabs : TokenOwns(tab[u], s) /\ tab'[u].slot = s /\ tab'[u].nonce = hold'[s].nonce
            \/ /\ hold[s].phase = "payment_pending"
               /\ hold'[s].failures = hold[s].failures + 1
               /\ hold'[s].exp = hold[s].exp
               /\ rec'[hold[s].rec].status = "failed"]_vars

PaymentHoldKeptThroughBackstop ==
  [][\A s \in Slots :
       (hold[s].phase = "payment_pending" /\ hold'[s].phase = "expired") => hold[s].exp + Backstop <= now]_vars

HeldSlotNeverTaken ==
  \A s \in Slots : HoldOwnsSlot(hold[s]) => lock[s] = 0

PaidInTimeKeepsSlot ==
  \A b \in bookings :
    (b.paidInTime /\ ~rec[b.id].outlived) => /\ b.kind = "slot"
                    /\ \A other \in SlotBookings(b.slot) : other.id = b.id

PaidInTimeNeverDisplaced ==
  \A n \in Nonces :
    (rec[n].paidInTime /\ rec[n].pay = "captured" /\ ~rec[n].outlived)
      => \A b \in SlotBookings(rec[n].slot) : b.id = n

TypedDetailsKept ==
  /\ \A n \in Nonces : rec[n].status # "none" => rec[n].details
  /\ [][\A t \in Tabs : tab[t].details => tab'[t].details]_vars

CommitOnlyAgainstActiveHold ==
  \A b \in bookings :
    b.kind = "slot" =>
      \/ /\ b.hold.phase = "payment_pending" /\ b.hold.rec = b.id /\ b.hold.nonce = b.id /\ b.hold.live
      \/ /\ ~b.hold.live /\ b.hold.nonce = b.id /\ b.hold.phase \in CommitPhases

OneBookingPerPayment ==
  /\ \A n \in Nonces : Cardinality(BookingFor(n)) <= 1
  /\ \A s \in Slots : Cardinality(SlotBookings(s)) <= 1
  /\ \A s \in Slots : lock[s] # 0 => \E b \in SlotBookings(s) : b.id = lock[s]

PaidBookingNeverLost ==
  \A n \in Nonces : (rec[n].pay = "captured") ~> (BookingFor(n) # {} \/ rec[n].terminal)

PaymentHoldsResolve ==
  \A s \in Slots :
    (hold[s].phase = "payment_pending")
      ~> (hold[s].phase # "payment_pending" \/ rec[hold[s].rec].knownCaptured)

PaymentHoldHasOwner ==
  \A s \in Slots :
    hold[s].phase = "payment_pending" => rec[hold[s].rec].status \in {"started", "needs_recovery"}

FailureCountBounded ==
  \A s \in Slots : hold[s].failures <= MaxRetries

RetainedFailureNeverExtendsExpiry ==
  [][\A s \in Slots :
       (hold[s].phase = "payment_pending" /\ hold'[s].phase = "active"
        /\ hold'[s].failures = hold[s].failures + 1)
         => hold'[s].exp = hold[s].exp]_vars

ObservedFailureNeverOriginalSlot ==
  \A b \in bookings :
    (b.id \in Nonces /\ (rec[b.id].failedObserved \/ rec[b.id].abandonedObserved)) => b.kind = "reschedule"

LateCaptureRequiresDurableClaim ==
  \A b \in bookings :
    (b.id \in Nonces /\ b.kind = "reschedule"
     /\ (rec[b.id].failedObserved \/ rec[b.id].abandonedObserved))
      => rec[b.id].lateCaptureClaimed

NotWitnessRetainedRetrySuccess ==
  ~(\E b \in bookings : b.kind = "slot" /\ b.id > 1 /\ \E n \in Nonces : rec[n].status = "failed")

NotWitnessThreeFailuresThenRelease ==
  ~(\E s \in Slots : hold[s].phase = "released" /\ hold[s].failures = MaxRetries)

NotWitnessReadThenCommitExpiryRace ==
  ~(\E s \in Slots : hold[s].phase = "active" /\ hold[s].retainedAfterExpiry /\ hold[s].failures >= 1 /\ hold[s].exp <= now)

NotWitnessVisitorClaimsExpiredRetained ==
  ~(\E s \in Slots, t \in Tabs :
      tab[t].slot = s /\ hold[s].phase = "active" /\ hold[s].failures = 0
      /\ hold[s].nonce >= 3 /\ \E n \in Nonces : rec[n].status = "failed")

NotWitnessLateCaptureAfterFailure ==
  ~(\E b \in bookings :
      b.id \in Nonces /\ b.kind = "reschedule" /\ rec[b.id].failedObserved /\ b.hold.rec # b.id)

NotWitnessClaimCrashReconcileReschedule ==
  ~(\E b \in bookings :
      b.id \in Nonces /\ b.kind = "reschedule"
      /\ rec[b.id].lateCaptureClaimed /\ rec[b.id].crashedAfterClaim)

NotWitnessPendingVetoFailureReschedule ==
  ~(\E b \in bookings :
      b.id \in Nonces /\ b.kind = "reschedule" /\ rec[b.id].failedObserved
      /\ b.hold.phase = "payment_pending" /\ b.hold.rec = b.id)

NotWitnessNonceBoundaryFallbackRelease ==
  ~(\E n \in Nonces, s \in Slots :
      rec[n].status = "failed" /\ nextNonce > MaxNonce
      /\ hold[s].phase = "released" /\ hold[s].failures < MaxRetries)

=============================================================================
