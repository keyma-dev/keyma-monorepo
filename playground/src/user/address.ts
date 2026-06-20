import { Schema, Validate, Indexed } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";

@Schema({ name: "address" })
export class Address {

    declare street: string;
}
