import {assertArgument, concat, defineProperties, getBigInt, getBytes, hexlify, id, keccak256, mask, toBeHex, toTwos, zeroPadValue} from "ethers";
import {ADDRESS_PREFIX, ADDRESS_PREFIX_REGEX} from './address';
import {byteArray2hexStr} from "./code"
import utils from "./index"
import {decodeBase58Address} from "./crypto"

function toHex(address) {
    if (utils.isHex(address)) {
        return address.toLowerCase().replace(/^0x/, ADDRESS_PREFIX);
    }
    return byteArray2hexStr(decodeBase58Address(address)).toLowerCase();
}

function getAddress(address) {
    return toHex(address).replace(ADDRESS_PREFIX_REGEX, '0x');
}

function getTronAddress(address) {
    return toHex(address);
}

const padding = new Uint8Array(32);
padding.fill(0);
const BN__1 = BigInt(-1);
const BN_0 = BigInt(0);
const BN_1 = BigInt(1);
const BN_MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

function hexPadRight(value) {
    const bytes = getBytes(value);
    const padOffset = bytes.length % 32;
    if (padOffset) {
        return concat([bytes, padding.slice(padOffset)]);
    }
    return hexlify(bytes);
}

const hexTrue = toBeHex(BN_1, 32);
const hexFalse = toBeHex(BN_0, 32);
const domainFieldTypes = {
    name: "string",
    version: "string",
    chainId: "uint256",
    verifyingContract: "address",
    salt: "bytes32"
};
const domainFieldNames = [
    "name", "version", "chainId", "verifyingContract", "salt"
];

function checkString(key) {
    return function (value) {
        assertArgument(typeof (value) === "string", `invalid domain value for ${JSON.stringify(key)}`, `domain.${key}`, value);
        return value;
    };
}

const domainChecks = {
    name: checkString("name"),
    version: checkString("version"),
    chainId: function (value) {
        return getBigInt(value, "domain.chainId");
    },
    verifyingContract: function (value) {
        try {
            return getTronAddress(value).toLowerCase();
        } catch (error) {
        }
        assertArgument(false, `invalid domain value "verifyingContract"`, "domain.verifyingContract", value);
    },
    salt: function (value) {
        const bytes = getBytes(value, "domain.salt");
        assertArgument(bytes.length === 32, `invalid domain value "salt"`, "domain.salt", value);
        return hexlify(bytes);
    }
};

function getBaseEncoder(type) {
    // intXX and uintXX
    {
        const match = type.match(/^(u?)int(\d*)$/);
        if (match) {
            const signed = (match[1] === "");
            const width = parseInt(match[2] || "256");
            assertArgument(width % 8 === 0 && width !== 0 && width <= 256 && (match[2] == null || match[2] === String(width)), "invalid numeric width", "type", type);
            const boundsUpper = mask(BN_MAX_UINT256, signed ? (width - 1) : width);
            const boundsLower = signed ? ((boundsUpper + BN_1) * BN__1) : BN_0;
            return function (_value) {
                const value = getBigInt(_value, "value");
                assertArgument(value >= boundsLower && value <= boundsUpper, `value out-of-bounds for ${type}`, "value", value);
                if (!signed) return toBeHex(value, 32);
                return toBeHex(toTwos(value, 256), 32);
            };
        }
    }
    // bytesXX
    {
        const match = type.match(/^bytes(\d+)$/);
        if (match) {
            const width = parseInt(match[1]);
            assertArgument(width !== 0 && width <= 32 && match[1] === String(width), "invalid bytes width", "type", type);
            return function (value) {
                const bytes = getBytes(value);
                assertArgument(bytes.length === width, `invalid length for ${type}`, "value", value);
                return hexPadRight(value);
            };
        }
    }
    switch (type) {
        case "trcToken":
            return getBaseEncoder('uint256');
        case "address":
            return function (value) {
                return zeroPadValue(getAddress(value), 32);
            };
        case "bool":
            return function (value) {
                return ((!value) ? hexFalse : hexTrue);
            };
        case "bytes":
            return function (value) {
                return keccak256(value);
            };
        case "string":
            return function (value) {
                return id(value);
            };
    }
    return null;
}

function encodeType(name, fields) {
    return `${name}(${fields.map(({name, type}) => (type + " " + name)).join(",")})`;
}

export class TypedDataEncoder {
    primaryType;
    _types;
    get types() {
        return JSON.parse(this._types);
    }

    _fullTypes;
    _encoderCache;

    constructor(types) {
        this._types = JSON.stringify(types);
        this._fullTypes = new Map();
        this._encoderCache = new Map();
        // Link struct types to their direct child structs
        const links = new Map();
        // Link structs to structs which contain them as a child
        const parents = new Map();
        // Link all subtypes within a given struct
        const subtypes = new Map();
        Object.keys(types).forEach((type) => {
            links.set(type, new Set());
            parents.set(type, []);
            subtypes.set(type, new Set());
        });
        for (const name in types) {
            const uniqueNames = new Set();
            for (const field of types[name]) {
                // Check each field has a unique name
                assertArgument(!uniqueNames.has(field.name), `duplicate variable name ${JSON.stringify(field.name)} in ${JSON.stringify(name)}`, "types", types);
                uniqueNames.add(field.name);
                // Get the base type (drop any array specifiers)
                const baseType = (field.type.match(/^([^\x5b]*)(\x5b|$)/))[1] || null;
                assertArgument(baseType !== name, `circular type reference to ${JSON.stringify(baseType)}`, "types", types);
                // Is this a base encoding type?
                const encoder = getBaseEncoder(baseType);
                if (encoder) {
                    continue;
                }
                assertArgument(parents.has(baseType), `unknown type ${JSON.stringify(baseType)}`, "types", types);
                // Add linkage
                parents.get(baseType).push(name);
                links.get(name).add(baseType);
            }
        }
        // Deduce the primary type
        const primaryTypes = Array.from(parents.keys()).filter((n) => (parents.get(n).length === 0));
        assertArgument(primaryTypes.length !== 0, "missing primary type", "types", types);
        assertArgument(primaryTypes.length === 1, `ambiguous primary types or unused types: ${primaryTypes.map((t) => (JSON.stringify(t))).join(", ")}`, "types", types);
        defineProperties(this, {primaryType: primaryTypes[0]});

        // Check for circular type references
        function checkCircular(type, found) {
            assertArgument(!found.has(type), `circular type reference to ${JSON.stringify(type)}`, "types", types);
            found.add(type);
            for (const child of links.get(type)) {
                if (!parents.has(child)) {
                    continue;
                }
                // Recursively check children
                checkCircular(child, found);
                // Mark all ancestors as having this decendant
                for (const subtype of found) {
                    subtypes.get(subtype).add(child);
                }
            }
            found.delete(type);
        }

        checkCircular(this.primaryType, new Set());
        // Compute each fully describe type
        for (const [name, set] of subtypes) {
            const st = Array.from(set);
            st.sort();
            this._fullTypes.set(name, encodeType(name, types[name]) + st.map((t) => encodeType(t, types[t])).join(""));
        }
    }

    getEncoder(type) {
        let encoder = this._encoderCache.get(type);
        if (!encoder) {
            encoder = this._getEncoder(type);
            this._encoderCache.set(type, encoder);
        }
        return encoder;
    }

    _getEncoder(type) {
        // Basic encoder type (address, bool, uint256, etc)
        {
            const encoder = getBaseEncoder(type);
            if (encoder) {
                return encoder;
            }
        }
        // Array
        const match = type.match(/^(.*)(\x5b(\d*)\x5d)$/);
        if (match) {
            const subtype = match[1];
            const subEncoder = this.getEncoder(subtype);
            return (value) => {
                assertArgument(!match[3] || parseInt(match[3]) === value.length, `array length mismatch; expected length ${parseInt(match[3])}`, "value", value);
                let result = value.map(subEncoder);
                if (this._fullTypes.has(subtype)) {
                    result = result.map(keccak256);
                }
                return keccak256(concat(result));
            };
        }
        // Struct
        const fields = this.types[type];
        if (fields) {
            const encodedType = id(this._fullTypes.get(type));
            return (value) => {
                const values = fields.map(({name, type}) => {
                    const result = this.getEncoder(type)(value[name]);
                    if (this._fullTypes.has(type)) {
                        return keccak256(result);
                    }
                    return result;
                });
                values.unshift(encodedType);
                return concat(values);
            };
        }
        assertArgument(false, `unknown type: ${type}`, "type", type);
    }

    encodeType(name) {
        const result = this._fullTypes.get(name);
        assertArgument(result, `unknown type: ${JSON.stringify(name)}`, "name", name);
        return result;
    }

    encodeData(type, value) {
        return this.getEncoder(type)(value);
    }

    hashStruct(name, value) {
        return keccak256(this.encodeData(name, value));
    }

    encode(value) {
        return this.encodeData(this.primaryType, value);
    }

    hash(value) {
        return this.hashStruct(this.primaryType, value);
    }

    _visit(type, value, callback) {
        // Basic encoder type (address, bool, uint256, etc)
        {
            const encoder = getBaseEncoder(type);
            if (encoder) {
                return callback(type, value);
            }
        }
        // Array
        const match = type.match(/^(.*)(\x5b(\d*)\x5d)$/);
        if (match) {
            assertArgument(!match[3] || parseInt(match[3]) === value.length, `array length mismatch; expected length ${parseInt(match[3])}`, "value", value);
            return value.map((v) => this._visit(match[1], v, callback));
        }
        // Struct
        const fields = this.types[type];
        if (fields) {
            return fields.reduce((accum, {name, type}) => {
                accum[name] = this._visit(type, value[name], callback);
                return accum;
            }, {});
        }
        assertArgument(false, `unknown type: ${type}`, "type", type);
    }

    visit(value, callback) {
        return this._visit(this.primaryType, value, callback);
    }

    static from(types) {
        return new TypedDataEncoder(types);
    }

    static getPrimaryType(types) {
        return TypedDataEncoder.from(types).primaryType;
    }

    static hashStruct(name, types, value) {
        return TypedDataEncoder.from(types).hashStruct(name, value);
    }

    static hashDomain(domain) {
        const domainFields = [];
        for (const name in domain) {
            if (domain[name] == null) {
                continue;
            }
            const type = domainFieldTypes[name];
            assertArgument(type, `invalid typed-data domain key: ${JSON.stringify(name)}`, "domain", domain);
            domainFields.push({name, type});
        }
        domainFields.sort((a, b) => {
            return domainFieldNames.indexOf(a.name) - domainFieldNames.indexOf(b.name);
        });
        return TypedDataEncoder.hashStruct("EIP712Domain", {EIP712Domain: domainFields}, domain);
    }

    static encode(domain, types, value) {
        return concat([
            "0x1901",
            TypedDataEncoder.hashDomain(domain),
            TypedDataEncoder.from(types).hash(value)
        ]);
    }

    static hash(domain, types, value) {
        return keccak256(TypedDataEncoder.encode(domain, types, value));
    }

    static getPayload(domain, types, value) {
        // Validate the domain fields
        TypedDataEncoder.hashDomain(domain);
        // Derive the EIP712Domain Struct reference type
        const domainValues = {};
        const domainTypes = [];
        domainFieldNames.forEach((name) => {
            const value = domain[name];
            if (value == null) {
                return;
            }
            domainValues[name] = domainChecks[name](value);
            domainTypes.push({name, type: domainFieldTypes[name]});
        });
        const encoder = TypedDataEncoder.from(types);
        const typesWithDomain = Object.assign({}, types);
        assertArgument(typesWithDomain.EIP712Domain == null, "types must not contain EIP712Domain type", "types.EIP712Domain", types);
        typesWithDomain.EIP712Domain = domainTypes;
        // Validate the data structures and types
        encoder.encode(value);
        return {
            types: typesWithDomain,
            domain: domainValues,
            primaryType: encoder.primaryType,
            message: encoder.visit(value, (type, value) => {
                // bytes
                if (type.match(/^bytes(\d*)/)) {
                    return hexlify(getBytes(value));
                }
                // uint or int
                if (type.match(/^u?int/)) {
                    return getBigInt(value).toString();
                }
                switch (type) {
                    case "trcToken":
                        return getBigInt(value).toString();
                    case "address":
                        return value.toLowerCase();
                    case "bool":
                        return !!value;
                    case "string":
                        assertArgument(typeof (value) === "string", "invalid string", "value", value);
                        return value;
                }
                assertArgument(false, "unsupported type", "type", type);
            })
        };
    }
}

//# sourceMappingURL=typed-data.js.map
