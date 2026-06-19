import { Schema, Edge, From, To } from "@keyma/dsl";
import type { ID, Reference } from "@keyma/dsl";

@Schema()
class Node {
    declare readonly id: ID;
}

// KEYMA065 — missing @To() endpoint
@Edge()
class MissingTo {
    declare readonly id: ID;
    @From() declare from: Node;
}

// KEYMA066 — duplicate @From() endpoint
@Edge()
class DuplicateFrom {
    declare readonly id: ID;
    @From() declare a: Node;
    @From() declare b: Node;
    @To() declare to: Node;
}

// KEYMA061 — endpoint field is not a node reference
@Edge()
class BadEndpointType {
    declare readonly id: ID;
    @From() declare from: string;
    @To() declare to: Node;
}

// A well-formed edge, referenced as a node below.
@Edge()
class Rel {
    declare readonly id: ID;
    @From() declare from: Node;
    @To() declare to: Node;
}

// KEYMA064 — non-edge schema references an edge
@Schema()
class ReferencesEdge {
    declare readonly id: ID;
    declare relation: Reference<Rel>;
}
