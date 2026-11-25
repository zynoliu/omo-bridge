import { BridgeData } from "../../../bridge-core/src/data.ts"
import { createDagLedger, connectBridgeDag } from "../../src/bridge/features/dag/index.ts"

const data = new BridgeData()
const ledger = createDagLedger()
connectBridgeDag(ledger, data, { onError: (m) => console.log("err", m) })
data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: "run-qa-1", seq: 1 } })
console.log("head", ledger.head("run-qa-1"), "events", ledger.events("run-qa-1").length)
