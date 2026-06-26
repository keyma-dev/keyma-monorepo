import { Schema, Edge, From, To } from "@keyma/schema/dsl";
import type { ID, Reference } from "@keyma/schema/dsl";

@Schema()
class Person {
    declare readonly id: ID;
    declare name: string;
}

@Schema()
class Company {
    declare readonly id: ID;
    declare name: string;
}

// Endpoints typed with Reference<T>; @From()/@To() are auto-indexed.
@Edge({ name: "knows", directed: false })
class Knows {
    declare readonly id: ID;
    @From() declare from: Reference<Person>;
    @To() declare to: Reference<Person>;
    declare since: string;
}

// Endpoints typed with Reference<T>; label defaults to name.
@Edge()
class WorksAt {
    declare readonly id: ID;
    @From() declare from: Reference<Person>;
    @To() declare to: Reference<Company>;
    declare role: string;
}
