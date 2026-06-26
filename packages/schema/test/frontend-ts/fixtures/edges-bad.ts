import { Schema, Edge, From, To } from "@keyma/schema/dsl";
import type { ID, Reference } from "@keyma/schema/dsl";

@Schema()
class Node {
    declare readonly id: ID;
}

// KEYMA065 — missing @To() endpoint
@Edge()
class MissingTo {
    declare readonly id: ID;
    @From() declare from: Reference<Node>;
}

// KEYMA066 — duplicate @From() endpoint
@Edge()
class DuplicateFrom {
    declare readonly id: ID;
    @From() declare a: Reference<Node>;
    @From() declare b: Reference<Node>;
    @To() declare to: Reference<Node>;
}

// KEYMA061 — endpoint field is not a node reference
@Edge()
class BadEndpointType {
    declare readonly id: ID;
    @From() declare from: string;
    @To() declare to: Reference<Node>;
}

// A well-formed edge, referenced as a node below.
@Edge()
class Rel {
    declare readonly id: ID;
    @From() declare from: Reference<Node>;
    @To() declare to: Reference<Node>;
}

// KEYMA064 — non-edge schema references an edge
@Schema()
class ReferencesEdge {
    declare readonly id: ID;
    declare relation: Reference<Rel>;
}
