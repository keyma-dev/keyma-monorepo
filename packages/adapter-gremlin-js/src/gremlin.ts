// Thin re-export layer over the official `gremlin` driver. Centralizes the
// process enums/anonymous-traversal we use so the rest of the adapter never
// imports the driver directly, and keeps the (CJS) interop in one place.
import gremlin from "gremlin";
import type { process as gprocess } from "gremlin";

const { P, statics, order, cardinality, t, column } = gremlin.process;
const { DriverRemoteConnection, Client } = gremlin.driver;

export { P, statics as __, order, cardinality, t, column, DriverRemoteConnection, Client };

/** Live, connected traversal source — the adapter's handle to the graph,
 *  analogous to a MongoDB `Db`. */
export type GraphTraversalSource = gprocess.GraphTraversalSource;
/** A (lazy) traversal under construction. */
export type GraphTraversal = gprocess.GraphTraversal;
export type EnumValue = gprocess.EnumValue;
