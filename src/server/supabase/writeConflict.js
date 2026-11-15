export const WRITE_CONFLICT_CODE = "PT409";

export const isWriteConflict = (error) =>
  String(error?.code || "") === WRITE_CONFLICT_CODE;
