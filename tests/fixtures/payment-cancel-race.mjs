export async function cancelWithReleaseFailure({ database, paymentId, cancel }) {
  const read = async id => (await database.sql`
    select payload from migration.source_documents where legacy_sanity_id = ${id}
  `)[0]?.payload;
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const wait = async (promise, message) => {
    let timeout;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 8000);
      })]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const stagesReady = deferred();
  const releaseReady = deferred();
  const releaseGate = deferred();
  let stages = 0;
  database.setRequestHook(async (phase, request) => {
    if (phase !== "before") return;
    const mutations = request.body?.p_mutations || [];
    if (mutations.some(item => item.document?._id === paymentId &&
        item.document.status === "abandoned" && item.document.resourceReleasePending === true &&
        String(item.document.recoveryReason || "").includes("customer_cancelled_expired"))) {
      if (++stages === 2) stagesReady.resolve();
      await wait(stagesReady.promise, "Both cancellation staging writes must arrive");
    }
    if (mutations.some(item => item.document?._type === "slotHold" &&
        item.document.releaseReason === "payment_session_released")) {
      releaseReady.resolve();
      await releaseGate.promise;
      throw new Error("Fixture transient database failure during resource release");
    }
  });
  const attempts = [cancel(), cancel()];
  const responses = Promise.all(attempts);
  responses.catch(() => {});
  let proof;
  try {
    await wait(releaseReady.promise, "The winning cancellation must attempt release");
    const first = await Promise.race(attempts);
    const whileReleasePending = await read(paymentId);
    proof = { stages, first, whileReleasePending,
      hold: await read(whileReleasePending.holdSnapshot.slotHoldId) };
  } finally {
    releaseGate.resolve();
    try {
      const settled = await responses;
      if (proof) Object.assign(proof, { responses: settled, finalPayment: await read(paymentId) });
    } finally {
      database.setRequestHook(null);
    }
  }
  return proof;
}
