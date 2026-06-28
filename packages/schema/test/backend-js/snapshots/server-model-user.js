import { minLength, required, trim } from "./schema.js";

export class User {
    static fromValue(value) {
        const instance = Object.create(this.prototype);
        instance._hydrate(value);
        return instance;
    }

    _hydrate(value) {
        if (value) {
            this.id = value.id;
            this.firstName = value.firstName;
            this.lastName = value.lastName;
            this.secretNote = value.secretNote;
        }
    }

    get fullName() {
        return `${this.firstName} ${this.lastName}`;
    }

    validate() {
        const ctx = { "object": this };
        return [required()(this.id, "id", ctx), minLength(2)(this.firstName, "firstName", ctx)].filter((__e) => __e != null);
    }

    formatChange() {
        const ctx = { "object": this };
        this.firstName = trim()(this.firstName, ctx);
    }
}

User.metadata = Object.freeze({
    "name": "user",
    "sourceName": "User",
    "fields": [
        {
            "name": "id",
            "type": {
                "kind": "id"
            },
            "readonly": true,
            "validators": [
                required()
            ],
            "indexes": [
                {
                    "unique": true
                }
            ]
        },
        {
            "name": "firstName",
            "type": {
                "kind": "string"
            },
            "validators": [
                minLength(2)
            ],
            "formatters": [
                {
                    "phase": "change",
                    "fn": trim()
                }
            ]
        },
        {
            "name": "lastName",
            "type": {
                "kind": "string"
            }
        },
        {
            "name": "secretNote",
            "type": {
                "kind": "string"
            },
            "visibility": "private",
            "required": false
        }
    ],
    "indexes": [
        {
            "fields": [
                {
                    "name": "firstName",
                    "direction": 1
                }
            ],
            "unique": false
        }
    ]
});
