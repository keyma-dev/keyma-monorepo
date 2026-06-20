import { Schema, Indexed, Computed, Reference } from "@keyma/dsl";
import type { ID } from "@keyma/dsl";
import { User } from "./user.js";

@Schema({
    name: "user-credentials",
    private: true
})
export class UserCredentials {

    declare readonly id: ID;

    @Indexed()
    declare user: Reference<User>;

    @Computed()
    @Indexed()
    get username(): string {
        return this.user.email;
    }

    declare hashedPassword: string;
}
