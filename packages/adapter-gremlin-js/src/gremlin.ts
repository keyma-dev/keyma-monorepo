// Thin re-export layer over the official `gremlin` driver. Centralizes the
// process enums/anonymous-traversal we use so the rest of the adapter never
// imports the driver directly, and keeps the (CJS) interop in one place.
import gremlin from "gremlin";
import type { process as gprocess } from "gremlin";

const { P, statics, order, cardinality, t, column, AnonymousTraversalSource } = gremlin.process;
const { DriverRemoteConnection, Client } = gremlin.driver;

export {
    P,
    statics as __,
    order,
    cardinality,
    t,
    column,
    AnonymousTraversalSource,
    DriverRemoteConnection,
    Client,
};

/** A live remote connection to a Gremlin server. */
export type DriverRemoteConnectionInstance = InstanceType<typeof DriverRemoteConnection>;

/** Produces a fresh, ready-to-use `DriverRemoteConnection`. Called by the
 *  adapter on first use and whenever the connection must be rebuilt (after a
 *  connection-level failure or once the configured max age elapses). Neptune
 *  consumers compute SigV4-signed headers here so each rebuilt connection
 *  carries fresh credentials. */
export type GremlinConnectionFactory =
    () => DriverRemoteConnectionInstance | Promise<DriverRemoteConnectionInstance>;

/** Live, connected traversal source — the adapter's handle to the graph,
 *  analogous to a MongoDB `Db`. */
export type GraphTraversalSource = gprocess.GraphTraversalSource;
/** A (lazy) traversal under construction. */
export type GraphTraversal = gprocess.GraphTraversal;
export type EnumValue = gprocess.EnumValue;
