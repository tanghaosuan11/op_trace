use std::cmp::Ordering;

use revm::{
    context::{
        journaled_state::{account::JournaledAccount, AccountInfoLoad, JournalLoadError},
    },
    context_interface::{
        journaled_state::{AccountLoad, JournalCheckpoint, TransferError},
        JournalTr,
    },

    inspector::JournalExt,
    interpreter::{SStoreResult,
        SelfDestructResult, StateLoad,
    },
    primitives::{
        hex::FromHex,
        hardfork::SpecId, Address, AddressMap, AddressSet,
        HashSet, Log, StorageKey, StorageValue, B256, U256,
    },
    state::{Account,  Bytecode, EvmState},
     Database, Journal, JournalEntry,
};

use anyhow::Result;
use std::{ fmt::Debug};
use std::collections::HashMap as HM;


type EthDeltasMap = HM<u32, HM<Address, (U256, U256)>>;

#[derive(Debug)]
pub struct OpTraceJournal<Db: Database> {
    journaled_state: Journal<Db>,
    current_transaction_id: u32,
    /// ETH 余额变化（按交易分组）：address -> (gained, lost)
    eth_deltas_by_tx: EthDeltasMap,
    /// 与 journal 的 checkpoint 对齐；REVERT 时恢复，避免子调用回滚后仍累计 transfer 记录
    eth_deltas_snapshots: Vec<EthDeltasMap>,
}

impl<Db: Database> OpTraceJournal<Db> {
    pub fn new(spec_id: SpecId, db: Db) -> Self {
        let mut journaled_state = Journal::new(db);
        journaled_state.set_spec_id(spec_id);
        Self {
            journaled_state,
            current_transaction_id: 0,
            eth_deltas_by_tx: HM::new(),
            eth_deltas_snapshots: Vec::new(),
        }
    }

    pub fn with_journaled_state(&self) -> &Journal<Db> {
        &self.journaled_state
    }

    pub fn set_transaction_id(&mut self, tid: u32) {
        self.current_transaction_id = tid;
    }

    pub fn take_eth_deltas_by_tx(&mut self) -> EthDeltasMap {
        std::mem::take(&mut self.eth_deltas_by_tx)
    }

    #[inline]
    fn push_eth_snapshot(&mut self) {
        self.eth_deltas_snapshots
            .push(self.eth_deltas_by_tx.clone());
    }

    #[inline]
    fn pop_eth_snapshot_restore(&mut self) {
        if let Some(prev) = self.eth_deltas_snapshots.pop() {
            self.eth_deltas_by_tx = prev;
        }
    }

    fn record_eth_gain(&mut self, address: Address, amount: U256) {
        if amount.is_zero() { return; }
        let tid = self.current_transaction_id;
        let entry = self.eth_deltas_by_tx.entry(tid).or_default();
        let e = entry.entry(address).or_insert((U256::ZERO, U256::ZERO));
        e.0 += amount;
    }

    fn record_eth_loss(&mut self, address: Address, amount: U256) {
        if amount.is_zero() { return; }
        let tid = self.current_transaction_id;
        let entry = self.eth_deltas_by_tx.entry(tid).or_default();
        let e = entry.entry(address).or_insert((U256::ZERO, U256::ZERO));
        e.1 += amount;
    }
}

impl<Db: Database + 'static> JournalTr for OpTraceJournal<Db> {
    type Database = Db;
    type State = EvmState;
    type JournaledAccount<'a> = JournaledAccount<'a, Db, JournalEntry>;

    fn new(database: Db) -> Self {
        Self::new(SpecId::default(), database)
    }

    fn db(&self) -> &Self::Database {
        self.journaled_state.db()
    }

    fn db_mut(&mut self) -> &mut Self::Database {
        self.journaled_state.db_mut()
    }

    fn sload(
        &mut self,
        address: Address,
        key: StorageKey,
    ) -> Result<StateLoad<StorageValue>, <Self::Database as Database>::Error> {
        self.journaled_state.sload(address, key)
    }

    fn sstore(
        &mut self,
        address: Address,
        key: StorageKey,
        value: StorageValue,
    ) -> Result<StateLoad<SStoreResult>, <Self::Database as Database>::Error> {
        self.journaled_state.sstore(address, key, value)
    }

    fn tload(&mut self, address: Address, key: StorageKey) -> StorageValue {
        self.journaled_state.tload(address, key)
    }

    fn tstore(&mut self, address: Address, key: StorageKey, value: StorageValue) {
        self.journaled_state.tstore(address, key, value)
    }

    fn log(&mut self, log: Log) {
        self.journaled_state.log(log)
    }

    fn logs(&self) -> &[Log] {
        self.journaled_state.logs()
    }

    fn selfdestruct(
        &mut self,
        address: Address,
        target: Address,
        skip_cold_load: bool,
    ) -> Result<StateLoad<SelfDestructResult>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .selfdestruct(address, target, skip_cold_load)
    }

    fn warm_access_list(&mut self, access_list: AddressMap<HashSet<StorageKey>>) {
        self.journaled_state.warm_access_list(access_list);
    }

    fn warm_coinbase_account(&mut self, address: Address) {
        self.journaled_state.warm_coinbase_account(address)
    }

    fn warm_precompiles(&mut self, addresses: AddressSet) {
        self.journaled_state.warm_precompiles(addresses)
    }

    fn precompile_addresses(&self) -> &AddressSet {
        self.journaled_state.precompile_addresses()
    }

    fn set_spec_id(&mut self, spec_id: SpecId) {
        self.journaled_state.set_spec_id(spec_id);
    }

    fn touch_account(&mut self, address: Address) {
        self.journaled_state.touch_account(address);
    }

    fn transfer(
        &mut self,
        from: Address,
        to: Address,
        balance: U256,
    ) -> Result<Option<TransferError>, <Self::Database as Database>::Error> {
        let r = self.journaled_state.transfer(from, to, balance)?;
        // 仅当转账成功（无错误）时记录 ETH 变化
        if r.is_none() {
            self.record_eth_loss(from, balance);
            self.record_eth_gain(to, balance);
        }
        Ok(r)
    }

    fn transfer_loaded(
        &mut self,
        from: Address,
        to: Address,
        balance: U256,
    ) -> Option<TransferError> {
        let r = self.journaled_state.transfer_loaded(from, to, balance);
        if r.is_none() {
            self.record_eth_loss(from, balance);
            self.record_eth_gain(to, balance);
        }
        r
    }

    fn load_account(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<&Account>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account(address)
    }

    fn load_account_with_code(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<&Account>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account_with_code(address)
    }

    fn load_account_delegated(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<AccountLoad>, <Self::Database as Database>::Error> {
        self.journaled_state.load_account_delegated(address)
    }

    fn set_code_with_hash(&mut self, address: Address, code: Bytecode, hash: B256) {
        self.journaled_state.set_code_with_hash(address, code, hash);
    }

    fn code(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<revm::primitives::Bytes>, <Self::Database as Database>::Error> {
        self.journaled_state.code(address)
    }

    fn code_hash(
        &mut self,
        address: Address,
    ) -> Result<StateLoad<B256>, <Self::Database as Database>::Error> {
        self.journaled_state.code_hash(address)
    }

    fn clear(&mut self) {
        self.eth_deltas_snapshots.clear();
        self.journaled_state.clear();
    }

    fn checkpoint(&mut self) -> JournalCheckpoint {
        self.push_eth_snapshot();
        self.journaled_state.checkpoint()
    }

    fn checkpoint_commit(&mut self) {
        self.journaled_state.checkpoint_commit();
        let _ = self.eth_deltas_snapshots.pop();
    }

    fn checkpoint_revert(&mut self, checkpoint: JournalCheckpoint) {
        self.journaled_state.checkpoint_revert(checkpoint);
        self.pop_eth_snapshot_restore();
    }

    fn create_account_checkpoint(
        &mut self,
        caller: Address,
        address: Address,
        balance: U256,
        spec_id: SpecId,
    ) -> Result<JournalCheckpoint, TransferError> {
        // 内部会调用 inner.checkpoint()，不经过本 struct 的 checkpoint()，这里单独压栈
        self.push_eth_snapshot();
        match self
            .journaled_state
            .create_account_checkpoint(caller, address, balance, spec_id)
        {
            Ok(cp) => Ok(cp),
            Err(e) => {
                self.pop_eth_snapshot_restore();
                Err(e)
            }
        }
    }

    /// Returns call depth.
    #[inline]
    fn depth(&self) -> usize {
        self.journaled_state.depth()
    }

    fn finalize(&mut self) -> Self::State {
        println!("[OpTraceJournal] finalize called at depth {}", self.depth());
        self.eth_deltas_snapshots.clear();
        self.journaled_state.finalize()
    }

    fn caller_accounting_journal_entry(
        &mut self,
        _address: Address,
        _old_balance: U256,
        _bump_nonce: bool,
    ) {
        // self.journaled_state.caller_accounting_journal_entry(address, old_balance, bump_nonce)
    }

    fn balance_incr(
        &mut self,
        address: Address,
        balance: U256,
    ) -> Result<(), <Self::Database as Database>::Error> {
        self.journaled_state.balance_incr(address, balance)?;
        // coinbase / refund 等增量也计入 ETH gain
        self.record_eth_gain(address, balance);
        Ok(())
    }

    fn nonce_bump_journal_entry(&mut self, _address: Address) {
        // self.journaled_state.nonce_bump_journal_entry(address)
    }

    fn take_logs(&mut self) -> Vec<Log> {
        self.journaled_state.take_logs()
    }

    fn commit_tx(&mut self) {
        println!("[OpTraceJournal] commit_tx called at depth {}", self.depth());
        self.eth_deltas_snapshots.clear();
        self.journaled_state.commit_tx()
    }

    fn discard_tx(&mut self) {
        let tid = self.current_transaction_id;
        self.eth_deltas_snapshots.clear();
        self.journaled_state.discard_tx();
        self.eth_deltas_by_tx.remove(&tid);
    }

    fn sload_skip_cold_load(
        &mut self,
        address: Address,
        key: StorageKey,
        skip_cold_load: bool,
    ) -> Result<StateLoad<StorageValue>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .sload_skip_cold_load(address, key, skip_cold_load)
    }

    fn sstore_skip_cold_load(
        &mut self,
        address: Address,
        key: StorageKey,
        value: StorageValue,
        skip_cold_load: bool,
    ) -> Result<StateLoad<SStoreResult>, JournalLoadError<<Self::Database as Database>::Error>>
    {
        self.journaled_state
            .sstore_skip_cold_load(address, key, value, skip_cold_load)
    }

    fn load_account_info_skip_cold_load(
        &mut self,
        address: Address,
        load_code: bool,
        skip_cold_load: bool,
    ) -> Result<AccountInfoLoad<'_>, JournalLoadError<<Self::Database as Database>::Error>> {
        self.journaled_state
            .load_account_info_skip_cold_load(address, load_code, skip_cold_load)
    }

    fn load_account_mut_optional_code(
        &mut self,
        address: Address,
        load_code: bool,
    ) -> Result<StateLoad<Self::JournaledAccount<'_>>, <Self::Database as Database>::Error> {
        self.journaled_state
            .load_account_mut_optional_code(address, load_code)
    }

    fn load_account_mut_skip_cold_load(
        &mut self,
        address: Address,
        skip_cold_load: bool,
    ) -> Result<StateLoad<Self::JournaledAccount<'_>>, <Self::Database as Database>::Error> {
        self.journaled_state
            .load_account_mut_skip_cold_load(address, skip_cold_load)
    }
    fn set_eip7708_config(&mut self, disabled: bool, delayed_burn_disabled: bool) {
        self.journaled_state
            .set_eip7708_config(disabled, delayed_burn_disabled);
    }
}

impl<Db: Database + 'static> JournalExt for OpTraceJournal<Db> {
    fn journal(&self) -> &[JournalEntry] {
        self.journaled_state.journal()
    }

    fn evm_state(&self) -> &EvmState {
        self.journaled_state.evm_state()
    }

    fn evm_state_mut(&mut self) -> &mut EvmState {
        self.journaled_state.evm_state_mut()
    }
}

/// 供 `patch_applier` 在泛型 `Context` 上约束 `journal_mut()`（仅 `OpTraceJournal` 实现）
pub trait OpTraceBalancePatch {
    fn apply_fork_balance_absolute(
        &mut self,
        addr: Address,
        target: U256,
        sink_primary: Address,
        patch_log_enabled: bool,
    );
}

impl<Db: Database + 'static> OpTraceBalancePatch for OpTraceJournal<Db> {
    fn apply_fork_balance_absolute(
        &mut self,
        addr: Address,
        target: U256,
        sink_primary: Address,
        patch_log_enabled: bool,
    ) {
        let sink_alt =
            Address::from_hex("0x000000000000000000000000000000000000dead").expect("dead sink");

        if let Err(e) = self.load_account(addr) {
            if patch_log_enabled {
                eprintln!("[PatchApplier] load_account {:?}: {e:?}", addr);
            }
            return;
        }

        let current = self
            .journaled_state
            .evm_state()
            .get(&addr)
            .map(|a| a.info.balance)
            .unwrap_or(U256::ZERO);

        match target.cmp(&current) {
            Ordering::Equal => {}
            Ordering::Greater => {
                let d = target - current;
                if let Err(e) = self.balance_incr(addr, d) {
                    if patch_log_enabled {
                        eprintln!("[PatchApplier] balance_incr {:?} +{:?}: {e:?}", addr, d);
                    }
                }
            }
            Ordering::Less => {
                let d = current - target;
                let to = if addr == sink_primary {
                    sink_alt
                } else {
                    sink_primary
                };
                if addr == to {
                    if patch_log_enabled {
                        eprintln!("[PatchApplier] balance decrease: addr equals sink, skip");
                    }
                    return;
                }
                match self.transfer(addr, to, d) {
                    Ok(terr) => {
                        if let Some(te) = terr {
                            if patch_log_enabled {
                                eprintln!(
                                    "[PatchApplier] transfer {:?} -> {:?} amount {:?}: {te:?}",
                                    addr, to, d
                                );
                            }
                        }
                    }
                    Err(e) => {
                        if patch_log_enabled {
                            eprintln!("[PatchApplier] transfer err: {e:?}");
                        }
                    }
                }
            }
        }
    }
}
