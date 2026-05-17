import { Schema, Validate, isRequired } from "@keyma/dsl";

@Schema({ name: "product" })
class Product {
    @Validate(isRequired)
    declare title: string;

    @Validate(isRequired)
    declare price: number;

    @Validate(isRequired)
    declare taxRate: number;

    get displayTitle(): string {
        return `${this.title}`;
    }

    get priceWithTax(): number {
        return this.price * (1 + this.taxRate);
    }

    get isExpensive(): boolean {
        return this.price > 100;
    }
}
