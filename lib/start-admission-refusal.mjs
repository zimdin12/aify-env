// A typed refusal before spawn. Generic errors and copied code/message strings remain execution-unknown.
export class StartAdmissionRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'StartAdmissionRefusal';
  }
}

export class RecoveryPending extends StartAdmissionRefusal {
  constructor(message) {
    super(`start refused while ownership recovery is incomplete: ${message}`);
    this.name = 'RecoveryPending';
    this.code = 'OWNERSHIP_RECOVERY_PENDING';
  }
}
