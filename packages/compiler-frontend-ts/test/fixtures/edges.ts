import { Schema, Edge, Indexed } from "@keyma/dsl";
import type { ID, Reference } from "@keyma/dsl";

@Schema()
class Person {
    @Indexed() declare readonly id: ID;
    declare name: string;
}

@Schema()
class Company {
    @Indexed() declare readonly id: ID;
    declare name: string;
}

@Edge({ from: Person, to: Person, label: "knows", directed: false })
class Knows {
    @Indexed() declare readonly id: ID;
    @Indexed() declare from: Reference<Person>;
    @Indexed() declare to: Reference<Person>;
    declare since: string;
}

@Edge({ from: Person, to: Company })
class WorksAt {
    @Indexed() declare readonly id: ID;
    @Indexed() declare from: Reference<Person>;
    @Indexed() declare to: Reference<Company>;
    declare role: string;
}
