//! EVM 符号表达式树（256-bit 位向量语义）+ SMT-LIB2 序列化
//!
//! 设计原则：
//! - 纯数据结构，不依赖 revm
//! - `None` 槽位代表具体值（不参与约束），只有 `Some(Expr)` 传播符号
//! - `Const(String)` 存 64 字符小写十六进制（无前缀），用于已知常量叶子

use serde::Serialize;
use std::collections::HashSet;

/// 32 字节大端序 → 64 字符小写十六进制（无 0x 前缀）
#[inline]
pub fn bytes32_to_hex64(b: &[u8; 32]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

/// EVM 256-bit 符号表达式
///
/// 所有值语义均为 mod 2^256 位向量，与 EVM 一致。
/// 比较运算符的结果也是 BV256（值为 0 或 1），而不是 Bool。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "op", content = "args")]
pub enum Expr {
    /// 具体常量：64 字符小写十六进制，无 0x 前缀
    Const(String),
    /// 符号变量，名称如 `"cd_4"`（calldata 偏移 4）
    Sym(String),

    // arithmetic
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),    // unsigned DIV
    Sdiv(Box<Expr>, Box<Expr>),   // signed SDIV
    Urem(Box<Expr>, Box<Expr>),   // unsigned MOD
    Srem(Box<Expr>, Box<Expr>),   // signed SMOD
    Addmod(Box<Expr>, Box<Expr>, Box<Expr>),
    Mulmod(Box<Expr>, Box<Expr>, Box<Expr>),
    Exp(Box<Expr>, Box<Expr>),
    Signext(Box<Expr>, Box<Expr>), // SIGNEXTEND(b, x): sign-extend x from (b*8+8)th bit

    // bitwise
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Xor(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    /// SHL: (shift_amount, value) — EVM: stack[0]=shift, stack[1]=value
    Shl(Box<Expr>, Box<Expr>),
    /// SHR logical: (shift_amount, value)
    Shr(Box<Expr>, Box<Expr>),
    /// SAR arithmetic: (shift_amount, value)
    Sar(Box<Expr>, Box<Expr>),
    /// BYTE(i, x): extract byte i (MSB = 0) of x, zero-extend to 256 bits
    Byteop(Box<Expr>, Box<Expr>),

    // comparison (BV256, 0 or 1)
    Lt(Box<Expr>, Box<Expr>),
    Gt(Box<Expr>, Box<Expr>),
    Slt(Box<Expr>, Box<Expr>),
    Sgt(Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>),
    Iszero(Box<Expr>),

    // hash (opaque; Z3 uses uninterpreted constant)
    /// Keccak256(uid, inputs): uid 是每次调用的唯一 ID，Z3 中声明为常量
    Keccak(u32, Vec<Expr>),
}

impl Expr {
    /// 从 32 字节大端序构建常量叶子
    #[inline]
    pub fn konst(bytes: [u8; 32]) -> Self {
        Expr::Const(bytes32_to_hex64(&bytes))
    }

    /// 判断是否不含任何 Symbol（即纯具体值）
    pub fn is_concrete(&self) -> bool {
        self.symbols().is_empty()
    }

    /// 收集所有叶子 Symbol 变量名
    pub fn symbols(&self) -> HashSet<String> {
        let mut out = HashSet::new();
        self.collect_symbols(&mut out);
        out
    }

    fn collect_symbols(&self, out: &mut HashSet<String>) {
        match self {
            Expr::Sym(n)   => { out.insert(n.clone()); }
            Expr::Const(_) => {}
            Expr::Not(a) | Expr::Iszero(a) => a.collect_symbols(out),
            Expr::Keccak(_, ch) => ch.iter().for_each(|c| c.collect_symbols(out)),
            Expr::Add(a,b)  | Expr::Sub(a,b)  | Expr::Mul(a,b)  | Expr::Div(a,b)
            | Expr::Sdiv(a,b) | Expr::Urem(a,b) | Expr::Srem(a,b)
            | Expr::Exp(a,b) | Expr::Signext(a,b)
            | Expr::And(a,b) | Expr::Or(a,b)  | Expr::Xor(a,b)
            | Expr::Shl(a,b) | Expr::Shr(a,b) | Expr::Sar(a,b) | Expr::Byteop(a,b)
            | Expr::Lt(a,b)  | Expr::Gt(a,b)  | Expr::Slt(a,b) | Expr::Sgt(a,b)
            | Expr::Eq(a,b) => { a.collect_symbols(out); b.collect_symbols(out); }
            Expr::Addmod(a,b,c) | Expr::Mulmod(a,b,c) => {
                a.collect_symbols(out); b.collect_symbols(out); c.collect_symbols(out);
            }
        }
    }

    /// 收集所有 Keccak 节点的唯一 UID（供 SMT-LIB2 声明用）
    pub fn keccak_uids(&self) -> HashSet<u32> {
        let mut out = HashSet::new();
        self.collect_keccak(&mut out);
        out
    }

    fn collect_keccak(&self, out: &mut HashSet<u32>) {
        match self {
            Expr::Keccak(uid, ch) => {
                out.insert(*uid);
                ch.iter().for_each(|c| c.collect_keccak(out));
            }
            Expr::Const(_) | Expr::Sym(_) => {}
            Expr::Not(a) | Expr::Iszero(a) => a.collect_keccak(out),
            Expr::Add(a,b)  | Expr::Sub(a,b)  | Expr::Mul(a,b)  | Expr::Div(a,b)
            | Expr::Sdiv(a,b) | Expr::Urem(a,b) | Expr::Srem(a,b)
            | Expr::Exp(a,b) | Expr::Signext(a,b)
            | Expr::And(a,b) | Expr::Or(a,b)  | Expr::Xor(a,b)
            | Expr::Shl(a,b) | Expr::Shr(a,b) | Expr::Sar(a,b) | Expr::Byteop(a,b)
            | Expr::Lt(a,b)  | Expr::Gt(a,b)  | Expr::Slt(a,b) | Expr::Sgt(a,b)
            | Expr::Eq(a,b) => { a.collect_keccak(out); b.collect_keccak(out); }
            Expr::Addmod(a,b,c) | Expr::Mulmod(a,b,c) => {
                a.collect_keccak(out); b.collect_keccak(out); c.collect_keccak(out);
            }
        }
    }


    /// 将表达式转为 SMT-LIB2 项（256-bit bitvector）
    pub fn to_smt2(&self) -> String {
        match self {
            Expr::Const(h) => format!("#x{}", h),
            Expr::Sym(n)   => n.clone(),

            // 算术
            Expr::Add(a,b)  => fmt2("bvadd",  a, b),
            Expr::Sub(a,b)  => fmt2("bvsub",  a, b),
            Expr::Mul(a,b)  => fmt2("bvmul",  a, b),
            Expr::Div(a,b)  => fmt2("bvudiv", a, b),
            Expr::Sdiv(a,b) => fmt2("bvsdiv", a, b),
            Expr::Urem(a,b) => fmt2("bvurem", a, b),
            Expr::Srem(a,b) => fmt2("bvsrem", a, b),
            Expr::Addmod(a,b,c) => format!("(bvurem (bvadd {} {}) {})", a.to_smt2(), b.to_smt2(), c.to_smt2()),
            Expr::Mulmod(a,b,c) => format!("(bvurem (bvmul {} {}) {})", a.to_smt2(), b.to_smt2(), c.to_smt2()),
            // EXP(base, exp): 小常量指数展开为乘法链，大/动态指数用 UF
            Expr::Exp(base, exp) => {
                if let Expr::Const(h) = exp.as_ref() {
                    // 解析指数值（最多取低 8 字节足够判断大小）
                    let exp_val = u64::from_str_radix(
                        &h[h.len().saturating_sub(16)..], 16
                    ).unwrap_or(u64::MAX);
                    match exp_val {
                        0 => format!("#x{}", { let mut s = "0".repeat(63); s.push('1'); s }),
                        1 => base.to_smt2(),
                        n @ 2..=8 => {
                            let b = base.to_smt2();
                            let mut acc = b.clone();
                            for _ in 1..n {
                                acc = format!("(bvmul {} {})", acc, b);
                            }
                            acc
                        }
                        _ => format!("(evm_exp {} {})", base.to_smt2(), exp.to_smt2()),
                    }
                } else {
                    format!("(evm_exp {} {})", base.to_smt2(), exp.to_smt2())
                }
            }
            // SIGNEXTEND(b, x): 当 b 为已知常量时用精确的 BV extract + sign_extend
            Expr::Signext(b, x) => {
                if let Expr::Const(h) = b.as_ref() {
                    let b_val = u64::from_str_radix(&h[h.len().saturating_sub(2)..], 16)
                        .unwrap_or(31) as usize;
                    if b_val >= 31 {
                        x.to_smt2() // 无需扩展
                    } else {
                        let bit_width = (b_val + 1) * 8;
                        let high_bit = bit_width - 1;
                        let ext_bits = 256 - bit_width;
                        format!("((_ sign_extend {}) ((_ extract {} 0) {}))",
                                ext_bits, high_bit, x.to_smt2())
                    }
                } else {
                    format!("(evm_signext {} {})", b.to_smt2(), x.to_smt2())
                }
            }

            // 位运算
            Expr::And(a,b) => fmt2("bvand",  a, b),
            Expr::Or(a,b)  => fmt2("bvor",   a, b),
            Expr::Xor(a,b) => fmt2("bvxor",  a, b),
            Expr::Not(a)   => format!("(bvnot {})", a.to_smt2()),
            // EVM SHL(shift, val) → SMT bvshl(val, shift)
            Expr::Shl(sh, v) => format!("(bvshl {} {})",  v.to_smt2(), sh.to_smt2()),
            Expr::Shr(sh, v) => format!("(bvlshr {} {})", v.to_smt2(), sh.to_smt2()),
            Expr::Sar(sh, v) => format!("(bvashr {} {})", v.to_smt2(), sh.to_smt2()),
            Expr::Byteop(i, x) => {
                // BYTE(i, x): extract byte i (MSB=0) from x, zero-extend to 256 bits
                // 当 i 为常量时用精确 BV extract
                if let Expr::Const(h) = i.as_ref() {
                    let i_val = u64::from_str_radix(
                        &h[h.len().saturating_sub(2)..], 16
                    ).unwrap_or(32);
                    if i_val >= 32 {
                        // 超出范围 → 0
                        format!("#x{}", "0".repeat(64))
                    } else {
                        // byte i (MSB=0) 在 BV256 中对应的小端位: bit[(31-i)*8+7 : (31-i)*8]
                        let low_bit = (31 - i_val as usize) * 8;
                        let high_bit = low_bit + 7;
                        format!("((_ zero_extend 248) ((_ extract {} {}) {}))",
                                high_bit, low_bit, x.to_smt2())
                    }
                } else {
                    format!("(evm_byte {} {})", i.to_smt2(), x.to_smt2())
                }
            }

            // 比较：EVM 返回 0/1 (BV256)，SMT 返回 Bool → 用 ite 包装
            Expr::Lt(a,b)  => ite("bvult", a, b),
            Expr::Gt(a,b)  => ite("bvugt", a, b),
            Expr::Slt(a,b) => ite("bvslt", a, b),
            Expr::Sgt(a,b) => ite("bvsgt", a, b),
            Expr::Eq(a,b)  => format!("(ite (= {} {}) (_ bv1 256) (_ bv0 256))",
                                      a.to_smt2(), b.to_smt2()),
            Expr::Iszero(a) => format!("(ite (= {} #x{}) (_ bv1 256) (_ bv0 256))",
                                       a.to_smt2(), "0".repeat(64)),

            // 哈希：引用已在头部声明的无解释常量 keccak_<uid>
            Expr::Keccak(uid, _) => format!("keccak_{}", uid),
        }
    }
}

#[inline]
fn fmt2(op: &str, a: &Expr, b: &Expr) -> String {
    format!("({} {} {})", op, a.to_smt2(), b.to_smt2())
}

#[inline]
fn ite(cmp_op: &str, a: &Expr, b: &Expr) -> String {
    format!("(ite ({} {} {}) (_ bv1 256) (_ bv0 256))",
            cmp_op, a.to_smt2(), b.to_smt2())
}

// ──────────────────────────────────────────────────────────────
// 反编译用 pseudocode 渲染：区别于 SMT-LIB2，面向人类阅读。
// ──────────────────────────────────────────────────────────────

/// 把 64 字符 hex 常量裁短：去掉前导零；保留 "0x"
fn short_hex(h: &str) -> String {
    let trimmed = h.trim_start_matches('0');
    if trimmed.is_empty() {
        "0x0".into()
    } else {
        format!("0x{}", trimmed)
    }
}

/// 识别 20 字节地址掩码 (0x00..00ffffffffffffffffffffffffffffffffffffffff)
fn is_address_mask(h: &str) -> bool {
    h.len() == 64 && h.starts_with(&"0".repeat(24)) && h[24..].chars().all(|c| c == 'f')
}

/// 是否是小的具体常量
fn small_const(h: &str) -> Option<u128> {
    let trimmed = h.trim_start_matches('0');
    if trimmed.is_empty() {
        return Some(0);
    }
    if trimmed.len() > 32 {
        return None;
    }
    u128::from_str_radix(trimmed, 16).ok()
}

/// 把符号名映射成更友好的展示（如 `cd_4` → `arg_0`）。
fn pretty_sym(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("cd_") {
        if let Ok(off) = rest.parse::<usize>() {
            if off == 0 {
                return "calldata[0:4]".into();
            }
            if off >= 4 && (off - 4) % 32 == 0 {
                let idx = (off - 4) / 32;
                return format!("arg{}", idx);
            }
            return format!("calldata[{}:{}]", off, off + 32);
        }
    }
    // 子帧合成的 calldata：cd@d{depth}_{off}
    if let Some(rest) = name.strip_prefix("cd@d") {
        if let Some((d, tail)) = rest.split_once('_') {
            if let (Ok(depth), Ok(off)) = (d.parse::<usize>(), tail.parse::<usize>()) {
                if off >= 4 && (off - 4) % 32 == 0 {
                    return format!("arg{}@d{}", (off - 4) / 32, depth);
                }
                return format!("calldata@d{}[{}:{}]", depth, off, off + 32);
            }
        }
    }
    name.to_string()
}

impl Expr {
    /// 生成可读的伪代码表达式（供反编译输出；不保证语义完整）。
    pub fn to_pseudo(&self) -> String {
        match self {
            Expr::Const(h) => short_hex(h),
            Expr::Sym(n) => pretty_sym(n),
            Expr::Keccak(uid, children) => {
                if children.is_empty() {
                    format!("keccak#{}", uid)
                } else {
                    let inner = children
                        .iter()
                        .map(|c| c.to_pseudo())
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("keccak256({})", inner)
                }
            }

            Expr::Add(a, b) => {
                // Keccak + const offset → struct 字段
                if let (Expr::Keccak(_, _), Expr::Const(h)) = (a.as_ref(), b.as_ref()) {
                    if let Some(off) = small_const(h) {
                        if off > 0 && off < 64 {
                            return format!("{} + {}", a.to_pseudo(), off);
                        }
                    }
                }
                format!("({} + {})", a.to_pseudo(), b.to_pseudo())
            }
            Expr::Sub(a, b) => format!("({} - {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Mul(a, b) => format!("({} * {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Div(a, b) => format!("({} / {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Sdiv(a, b) => format!("({} /s {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Urem(a, b) => format!("({} % {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Srem(a, b) => format!("({} %s {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Addmod(a, b, c) => {
                format!("addmod({}, {}, {})", a.to_pseudo(), b.to_pseudo(), c.to_pseudo())
            }
            Expr::Mulmod(a, b, c) => {
                format!("mulmod({}, {}, {})", a.to_pseudo(), b.to_pseudo(), c.to_pseudo())
            }
            Expr::Exp(a, b) => format!("({} ** {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Signext(b, x) => format!("signextend({}, {})", b.to_pseudo(), x.to_pseudo()),

            // SHR(0xe0, CALLDATALOAD(0)) → selector
            Expr::Shr(sh, v) => {
                if let Expr::Const(h) = sh.as_ref() {
                    if let Some(shift_bits) = small_const(h) {
                        if shift_bits == 224 {
                            if let Expr::Sym(n) = v.as_ref() {
                                if n == "cd_0" {
                                    return "msg.sig".into();
                                }
                            }
                        }
                        return format!("({} >> {})", v.to_pseudo(), shift_bits);
                    }
                }
                format!("({} >> {})", v.to_pseudo(), sh.to_pseudo())
            }
            Expr::Shl(sh, v) => format!("({} << {})", v.to_pseudo(), sh.to_pseudo()),
            Expr::Sar(sh, v) => format!("({} >>a {})", v.to_pseudo(), sh.to_pseudo()),

            // AND(x, 0xff..ff<20bytes>) → address(x)
            Expr::And(a, b) => {
                if let Expr::Const(h) = b.as_ref() {
                    if is_address_mask(h) {
                        return format!("address({})", a.to_pseudo());
                    }
                    if small_const(h) == Some(0xff) {
                        return format!("uint8({})", a.to_pseudo());
                    }
                }
                if let Expr::Const(h) = a.as_ref() {
                    if is_address_mask(h) {
                        return format!("address({})", b.to_pseudo());
                    }
                }
                format!("({} & {})", a.to_pseudo(), b.to_pseudo())
            }
            Expr::Or(a, b) => format!("({} | {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Xor(a, b) => format!("({} ^ {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Not(a) => format!("~{}", a.to_pseudo()),
            Expr::Byteop(i, x) => format!("byte({}, {})", i.to_pseudo(), x.to_pseudo()),

            Expr::Lt(a, b) => format!("({} < {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Gt(a, b) => format!("({} > {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Slt(a, b) => format!("({} <s {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Sgt(a, b) => format!("({} >s {})", a.to_pseudo(), b.to_pseudo()),
            Expr::Eq(a, b) => format!("({} == {})", a.to_pseudo(), b.to_pseudo()),

            // ISZERO(EQ) → != ;  ISZERO(ISZERO(x)) → bool(x) ; ISZERO(x) → !x
            Expr::Iszero(inner) => match inner.as_ref() {
                Expr::Eq(a, b) => format!("({} != {})", a.to_pseudo(), b.to_pseudo()),
                Expr::Iszero(x) => format!("bool({})", x.to_pseudo()),
                Expr::Lt(a, b) => format!("({} >= {})", a.to_pseudo(), b.to_pseudo()),
                Expr::Gt(a, b) => format!("({} <= {})", a.to_pseudo(), b.to_pseudo()),
                _ => format!("!{}", inner.to_pseudo()),
            },
        }
    }
}
