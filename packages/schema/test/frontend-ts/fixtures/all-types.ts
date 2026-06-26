import { Schema } from "@keyma/schema/dsl";
import type { ID, DateOnly, DateTime, TimeOfDay, Decimal, Json, Bytes, Nullable, Reference, Embedded } from "@keyma/schema/dsl";

@Schema({ name: "address" })
class Address {
    declare id: ID;
    declare street: string;
}

@Schema({ name: "all_types" })
class AllTypes {
    declare id: ID;
    declare name: string;
    declare count: number;
    declare flag: boolean;
    declare big: bigint;
    declare date: DateOnly;
    declare ts: DateTime;
    declare time: TimeOfDay;
    declare money: Decimal;
    declare blob: Bytes;
    declare meta: Json;
    declare tags: string[];
    declare status: "draft" | "published" | "archived";
    declare maybe?: string;
    declare nullableStr: string | null;
    declare addr: Reference<Address>;
    declare embedded: Embedded<Address>;
    declare nullableRef: Nullable<Reference<Address>>;
}
