import { controllerApi } from './controller-api'
import { ReconcileQueue } from './reconcile-queue'

export const controllerReconcileQueue = new ReconcileQueue({
  maxBatchSize: 50,
})

controllerReconcileQueue.register('Worker', (request) =>
  controllerApi.handleReconcileRequest(request),
)
controllerReconcileQueue.register('Manager', (request) =>
  controllerApi.handleReconcileRequest(request),
)
controllerReconcileQueue.register('Run', (request) =>
  controllerApi.handleReconcileRequest(request),
)
controllerReconcileQueue.register('Room', (request) =>
  controllerApi.handleReconcileRequest(request),
)
controllerReconcileQueue.register('RuntimeLease', (request) =>
  controllerApi.handleReconcileRequest(request),
)
