import { Schema, Edge, From, To } from "@keyma/dsl";
import type { ID, Reference } from "@keyma/dsl";

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

// Endpoints typed with bare node classes; @From()/@To() are auto-indexed.
@Edge({ name: "knows", directed: false })
class Knows {
    declare readonly id: ID;
    @From() declare from: Person;
    @To() declare to: Person;
    declare since: string;
}

// Endpoints typed with Reference<T> (still accepted); label defaults to name.
@Edge()
class WorksAt {
    declare readonly id: ID;
    @From() declare from: Reference<Person>;
    @To() declare to: Reference<Company>;
    declare role: string;
}
