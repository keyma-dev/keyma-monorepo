import { Schema, Validate, Computed } from "@keyma/dsl";
function isRequired() { return { __validatorName: "required" } as const; }

@Schema({ name: "product" })
class Product {
    @Validate(isRequired())
    declare title: string;

    @Validate(isRequired())
    declare price: number;

    @Validate(isRequired())
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
