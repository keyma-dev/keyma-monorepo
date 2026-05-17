import { Schema, Edge, Indexed } from "@keyma/dsl";
import type { ID, Reference } from "@keyma/dsl";

@Schema()
class Node {
    @Indexed() declare readonly id: ID;
}

// KEYMA062 — `from` field not indexed
@Edge({ from: Node, to: Node })
class MissingIndex {
    @Indexed() declare readonly id: ID;
    declare from: Reference<Node>;
    @Indexed() declare to: Reference<Node>;
}

// KEYMA061 — `to` field missing
@Edge({ from: Node, to: Node })
class MissingToField {
    @Indexed() declare readonly id: ID;
    @Indexed() declare from: Reference<Node>;
}

// KEYMA064 — non-edge schema references an edge
@Schema()
class ReferencesEdge {
    @Indexed() declare readonly id: ID;
    declare relation: Reference<MissingToField>;
}
