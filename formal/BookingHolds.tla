---------------------------- MODULE BookingHolds ----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Tabs, Slots, HoldMinutes, Backstop, MaxTime, MaxNonce

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

EmptyHold == [phase |-> "none", nonce |-> NoNonce, exp |-> 0, rec |-> NoNonce]
EmptyTab == [slot |-> NoSlot, nonce |-> NoNonce, exp |-> 0, details |-> FALSE, paying |-> NoNonce]
EmptyRec == [status |-> "none", slot |-> NoSlot, tokenExp |-> 0, created |-> 0,
             pay |-> "open", paidInTime |-> FALSE, details |-> FALSE, knownCaptured |-> FALSE, terminal |-> FALSE,
             outlived |-> FALSE, valid |-> TRUE, merchantReview |-> FALSE]

TypeOK ==
  /\ now \in Times
  /\ nextNonce \in 1..(MaxNonce + 1)
  /\ hold \in [Slots -> [phase : {"none", "released", "consumed", "expired"} \cup LivePhases,
                         nonce : 0..DeadNonce, exp : Times, rec : 0..MaxNonce]]
  /\ lock \in [Slots -> 0..RestoredId]
  /\ tab \in [Tabs -> [slot : Slots \cup {NoSlot}, nonce : 0..MaxNonce, exp : Times,
                       details : BOOLEAN, paying : 0..MaxNonce]]
  /\ rec \in [Nonces -> [status : {"none", "started", "needs_recovery", "booked", "rescheduled", "abandoned"},
                         slot : Slots \cup {NoSlot}, tokenExp : Times, created : Times,
                         pay : {"open", "processing", "captured", "closed"},
                         paidInTime : BOOLEAN, details : BOOLEAN, knownCaptured : BOOLEAN, terminal : BOOLEAN,
                         outlived : BOOLEAN, valid : BOOLEAN, merchantReview : BOOLEAN]]

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

ReleasedHold(h) == [h EXCEPT !.phase = "released", !.nonce = DeadNonce, !.exp = now, !.rec = NoNonce]

PaymentReleasedHold(h) == [h EXCEPT !.phase = "released", !.exp = now, !.rec = NoNonce]

ConsumedHold(h) == [h EXCEPT !.phase = "consumed", !.exp = now]

HoldSlot(t, s) ==
  LET tk == tab[t]
      h == hold[s]
      prev == tk.slot
      movingFromPendingPayment ==
        prev \notin {NoSlot, s} /\ TokenOwns(tk, prev) /\ hold[prev].phase = "payment_pending"
      releasePrevious ==
        prev \notin {NoSlot, s} /\ TokenOwns(tk, prev) /\ hold[prev].phase # "payment_pending"
      granted == [phase |-> "active", nonce |-> nextNonce, exp |-> now + HoldMinutes, rec |-> NoNonce]
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
                                       ![s].exp = now + HoldMinutes]
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
               /\ hold' = [hold EXCEPT ![s].phase = "holding", ![s].nonce = nextNonce, ![s].rec = NoNonce]
               /\ tab' = [tab EXCEPT ![t].nonce = nextNonce, ![t].exp = hold[s].exp, ![t].paying = NoNonce]
               /\ nextNonce' = nextNonce + 1
          ELSE /\ hold' = [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])]
               /\ tab' = [tab EXCEPT ![t].paying = NoNonce]
               /\ UNCHANGED nextNonce
     /\ rec' = [rec EXCEPT ![n].status = "abandoned"]
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

MerchantReviewBegins(n) ==
  LET s == rec[n].slot
  IN /\ rec[n].pay = "processing"
     /\ hold[s].phase = "payment_pending"
     /\ hold[s].rec = n
     /\ rec' = [rec EXCEPT ![n].merchantReview = TRUE]
     /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

PaymentSucceeds(n) ==
  /\ rec[n].pay = "processing"
  /\ \E valid \in BOOLEAN : rec' = [rec EXCEPT ![n].pay = "captured", ![n].valid = valid,
                                             ![n].merchantReview = FALSE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

PaymentFails(n) ==
  /\ rec[n].pay = "processing"
  /\ rec' = [rec EXCEPT ![n].pay = "open", ![n].merchantReview = FALSE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

CheckoutExpires(n) ==
  LET s == rec[n].slot
  IN /\ rec[n].status \in {"started", "needs_recovery", "abandoned"}
     /\ rec[n].pay = "open"
     /\ rec' = [rec EXCEPT ![n].pay = "closed", ![n].status = "abandoned"]
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
     /\ rec' = [rec EXCEPT ![n].status = "booked"]

RecordReschedule(n) ==
  LET s == rec[n].slot
  IN /\ bookings' = IF BookingFor(n) = {}
                      THEN bookings \cup {[id |-> n, slot |-> NoSlot, kind |-> "reschedule",
                                           hold |-> Snapshot(n), paidInTime |-> rec[n].paidInTime]}
                      ELSE bookings
     /\ hold' = IF hold[s].rec = n THEN [hold EXCEPT ![s] = ConsumedHold(hold[s])] ELSE hold
     /\ rec' = [rec EXCEPT ![n].status = IF BookingFor(n) = {} THEN "rescheduled" ELSE "booked"]
     /\ UNCHANGED lock

MarkNeedsRecovery(n) ==
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery",
                          ![n].terminal = FALSE,
                          ![n].knownCaptured = rec[n].knownCaptured \/ rec[n].pay = "captured"]
  /\ UNCHANGED <<hold, lock, bookings>>

FinalizeCapture(n) ==
  /\ rec[n].pay = "captured"
  /\ rec[n].valid
  /\ rec[n].status \in {"started", "needs_recovery", "abandoned"}
  /\ IF rec[n].status = "abandoned"
       THEN RecordReschedule(n)
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
  /\ IF CanCommit(n) THEN CommitBooking(n) ELSE RecordReschedule(n)
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
     /\ rec' = [rec EXCEPT ![n].status = "abandoned"]
     /\ hold' = IF hold[s].rec = n THEN [hold EXCEPT ![s] = PaymentReleasedHold(hold[s])] ELSE hold
     /\ UNCHANGED <<now, nextNonce, lock, tab, bookings>>

CleanupExpiredHold(s) ==
  /\ hold[s].phase \in {"active", "holding"}
  /\ hold[s].exp <= now
  /\ hold' = [hold EXCEPT ![s].phase = "expired", ![s].nonce = DeadNonce]
  /\ UNCHANGED <<now, nextNonce, lock, tab, rec, bookings>>

RecoveryGivesUp(n) ==
  /\ rec[n].status \in {"started", "needs_recovery"}
  /\ ~rec[n].terminal
  /\ \E observed \in BOOLEAN :
       rec' = [rec EXCEPT ![n].terminal = ~((rec[n].knownCaptured \/ observed)
                                            /\ rec[n].pay = "captured" /\ rec[n].valid),
                            ![n].knownCaptured = rec[n].knownCaptured \/ (observed /\ rec[n].pay = "captured")]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

ReconcileRejectsCapture(n) ==
  /\ rec[n].pay = "captured"
  /\ ~rec[n].valid
  /\ ~rec[n].terminal
  /\ rec[n].status \in {"started", "needs_recovery", "abandoned"}
  /\ rec' = [rec EXCEPT ![n].status = "needs_recovery", ![n].terminal = TRUE, ![n].knownCaptured = TRUE]
  /\ UNCHANGED <<now, nextNonce, hold, lock, tab, bookings>>

WebhookRecordsCapture(n) ==
  /\ rec[n].terminal
  /\ rec[n].pay = "captured"
  /\ ~rec[n].knownCaptured
  /\ rec' = [rec EXCEPT ![n].knownCaptured = TRUE, ![n].terminal = ~rec[n].valid]
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
  /\ ~rec[hold[s].rec].merchantReview
  /\ hold' = [hold EXCEPT ![s].phase = "expired", ![s].nonce = DeadNonce]
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
  \/ \E n \in Nonces : \/ SubmitPayment(n) \/ MerchantReviewBegins(n)
                       \/ PaymentSucceeds(n) \/ PaymentFails(n) \/ CheckoutExpires(n)
                       \/ FinalizeCapture(n) \/ ReconcileRecovery(n) \/ ReconcilePending(n)
                       \/ ReconcileUnpaid(n) \/ RecoveryGivesUp(n) \/ WebhookRecordsCapture(n)
                       \/ OwnerRefundsUnbookedCapture(n) \/ ReconcileRejectsCapture(n)

Server(n) == FinalizeCapture(n) \/ ReconcileRecovery(n) \/ ReconcilePending(n)
             \/ ReconcileUnpaid(n) \/ WebhookRecordsCapture(n) \/ ReconcileRejectsCapture(n)

Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ \A n \in Nonces : WF_vars(Server(n)) /\ SF_vars(CheckoutExpires(n))
          /\ \A s \in Slots : WF_vars(UnconfirmedPaymentHoldExpires(s))

OneHoldPerSlotStart ==
  \A s \in Slots :
    /\ hold[s].phase = "payment_pending" => hold[s].rec = hold[s].nonce
    /\ Cardinality({n \in Nonces : hold[s].phase = "payment_pending" /\ hold[s].rec = n}) <= 1

NoSecondHoldOverLiveHold ==
  [][\A s \in Slots :
       (hold'[s].nonce # hold[s].nonce /\ hold'[s].phase = "active" /\ HoldOwnsSlot(hold[s]))
         => /\ hold[s].phase # "payment_pending"
            /\ \E u \in Tabs : TokenOwns(tab[u], s) /\ tab'[u].slot = s /\ tab'[u].nonce = hold'[s].nonce]_vars

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
      ~> (hold[s].phase # "payment_pending" \/ rec[hold[s].rec].knownCaptured
           \/ rec[hold[s].rec].merchantReview)

MerchantReviewHoldRetained ==
  [][\A s \in Slots :
       (hold[s].phase = "payment_pending" /\ rec[hold[s].rec].merchantReview)
         => hold'[s].phase # "expired"]_vars

VerifiedCaptureKeepsRetrying ==
  \A n \in Nonces :
    (rec[n].knownCaptured /\ rec[n].pay = "captured" /\ rec[n].valid /\ BookingFor(n) = {})
      => ~rec[n].terminal

PaymentHoldHasOwner ==
  \A s \in Slots :
    hold[s].phase = "payment_pending" => rec[hold[s].rec].status \in {"started", "needs_recovery"}

=============================================================================
