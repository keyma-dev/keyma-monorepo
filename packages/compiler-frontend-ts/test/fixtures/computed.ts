import { Schema, Validate, Computed } from "@keyma/dsl";
import type { ValidatorFn, Json } from "@keyma/dsl";
function required(): ValidatorFn<Json> { return (value, field) => value !== null ? null : { field: field, code: "required", message: "required" }; }

@Schema({ name: "product" })
class Product {
    @Validate(required())
    declare title: string;

    @Validate(required())
    declare price: number;

    @Validate(required())
    declare taxRate: number;

    @Computed() get displayTitle(): string {
        return `${this.title}`;
    }

    @Computed() get priceWithTax(): number {
        return this.price * (1 + this.taxRate);
    }

    @Computed() get isExpensive(): boolean {
        return this.price > 100;
    }
}
