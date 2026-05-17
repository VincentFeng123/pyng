export class AbortFlowError extends Error {
  constructor() {
    super('flow aborted');
    this.name = 'AbortFlowError';
  }
}
