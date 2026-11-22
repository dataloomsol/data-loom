#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};
declare_id!("Gr8cD4uBjjp6ERzeNvpUr8vpKv2NkneF3TqvUBb5dKtw");
const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

#[program]
pub mod loom_data_escrow {
 use super::*;
 pub fn create(ctx:Context<Create>,nonce:[u8;32],terms_hash:[u8;32],contributor:Pubkey,verifier:Pubkey,platform:Pubkey,amount:u64,deadline:i64)->Result<()> {
  let now=Clock::get()?.unix_timestamp;
  require!(amount>=10_000&&amount<=1_000_000_000,EscrowError::Terms);
  require!(deadline>now&&deadline<=now+30*86400,EscrowError::Terms);
  require!(terms_hash!=[0;32]&&contributor!=Pubkey::default()&&verifier!=Pubkey::default()&&platform!=Pubkey::default(),EscrowError::Terms);
  require!(contributor!=ctx.accounts.buyer.key()&&platform!=contributor&&platform!=ctx.accounts.buyer.key(),EscrowError::Terms);
  let e=&mut ctx.accounts.escrow;
  e.buyer=ctx.accounts.buyer.key();e.contributor=contributor;e.verifier=verifier;e.platform=platform;e.nonce=nonce;e.terms_hash=terms_hash;e.amount=amount;e.deadline=deadline;e.state=0;e.bump=ctx.bumps.escrow;e.report_hash=[0;32];
  Ok(())
 }
 pub fn accept(ctx:Context<Accept>,terms_hash:[u8;32])->Result<()> {
  let e=&mut ctx.accounts.escrow;
  require!(e.state==0&&e.terms_hash==terms_hash&&Clock::get()?.unix_timestamp<e.deadline,EscrowError::State);
  e.state=1;Ok(())
 }
 pub fn fund(ctx:Context<Fund>,terms_hash:[u8;32])->Result<()> {
  let e=&ctx.accounts.escrow;
  require!(e.state==1&&e.terms_hash==terms_hash&&Clock::get()?.unix_timestamp<e.deadline,EscrowError::State);
  token::transfer_checked(CpiContext::new(ctx.accounts.token_program.to_account_info(),TransferChecked{from:ctx.accounts.buyer_tokens.to_account_info(),mint:ctx.accounts.mint.to_account_info(),to:ctx.accounts.vault.to_account_info(),authority:ctx.accounts.buyer.to_account_info()}),e.amount,6)?;
  ctx.accounts.escrow.state=2;Ok(())
 }
 // This verifies the agreed verifier's signature, NOT the underlying quality algorithm.
 // The verifier may sign only after independently checking finalized funding and
 // evaluating a version-bound encrypted dataset snapshot against the accepted terms.
 pub fn release(ctx:Context<Release>,terms_hash:[u8;32],report_hash:[u8;32])->Result<()> {
  let e=&ctx.accounts.escrow;
  require!(e.state==2&&e.terms_hash==terms_hash&&report_hash!=[0;32]&&Clock::get()?.unix_timestamp<e.deadline,EscrowError::State);
  require!(ctx.accounts.vault.amount>=e.amount,EscrowError::Balance);
  let amount=e.amount;let contributor=amount*70/100;let extra=ctx.accounts.vault.amount-amount;
  let bump=[e.bump];let seeds:&[&[u8]]=&[b"escrow",e.buyer.as_ref(),&e.nonce,&bump];let signer=&[seeds];
  macro_rules! transfer { ($to:expr,$value:expr) => { token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),TransferChecked{from:ctx.accounts.vault.to_account_info(),mint:ctx.accounts.mint.to_account_info(),to:$to,authority:ctx.accounts.escrow.to_account_info()},signer),$value,6)? }; }
  transfer!(ctx.accounts.contributor_tokens.to_account_info(),contributor);
  transfer!(ctx.accounts.platform_tokens.to_account_info(),amount-contributor);
  if extra>0 {transfer!(ctx.accounts.buyer_tokens.to_account_info(),extra);}
  token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),CloseAccount{account:ctx.accounts.vault.to_account_info(),destination:ctx.accounts.buyer.to_account_info(),authority:ctx.accounts.escrow.to_account_info()},signer))?;
  ctx.accounts.escrow.state=3;ctx.accounts.escrow.report_hash=report_hash;Ok(())
 }
 pub fn refund(ctx:Context<Refund>)->Result<()> {
  let e=&ctx.accounts.escrow;
  require!((e.state==0||e.state==1||e.state==2)&&Clock::get()?.unix_timestamp>=e.deadline,EscrowError::State);
  let bump=[e.bump];let seeds:&[&[u8]]=&[b"escrow",e.buyer.as_ref(),&e.nonce,&bump];let signer=&[seeds];
  token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),TransferChecked{from:ctx.accounts.vault.to_account_info(),mint:ctx.accounts.mint.to_account_info(),to:ctx.accounts.buyer_tokens.to_account_info(),authority:ctx.accounts.escrow.to_account_info()},signer),ctx.accounts.vault.amount,6)?;
  token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(),CloseAccount{account:ctx.accounts.vault.to_account_info(),destination:ctx.accounts.buyer.to_account_info(),authority:ctx.accounts.escrow.to_account_info()},signer))?;
  ctx.accounts.escrow.state=4;Ok(())
 }
}
#[account]
#[derive(InitSpace)]
pub struct Escrow {pub buyer:Pubkey,pub contributor:Pubkey,pub verifier:Pubkey,pub platform:Pubkey,pub nonce:[u8;32],pub terms_hash:[u8;32],pub report_hash:[u8;32],pub amount:u64,pub deadline:i64,pub state:u8,pub bump:u8}
#[derive(Accounts)]
#[instruction(nonce:[u8;32])]
pub struct Create<'info>{
 #[account(mut)]pub buyer:Signer<'info>,
 #[account(init,payer=buyer,space=8+Escrow::INIT_SPACE,seeds=[b"escrow",buyer.key().as_ref(),&nonce],bump)]pub escrow:Box<Account<'info,Escrow>>,
 #[account(address=USDC,constraint=mint.decimals==6)]pub mint:Box<Account<'info,Mint>>,
 #[account(init,payer=buyer,token::mint=mint,token::authority=escrow,seeds=[b"vault",escrow.key().as_ref()],bump)]pub vault:Box<Account<'info,TokenAccount>>,
 pub token_program:Program<'info,Token>,pub system_program:Program<'info,System>,pub rent:Sysvar<'info,Rent>
}
#[derive(Accounts)]
pub struct Accept<'info>{pub contributor:Signer<'info>,#[account(mut,has_one=contributor,seeds=[b"escrow",escrow.buyer.as_ref(),&escrow.nonce],bump=escrow.bump)]pub escrow:Box<Account<'info,Escrow>>}
#[derive(Accounts)]
pub struct Fund<'info>{
 pub buyer:Signer<'info>,#[account(mut,has_one=buyer,seeds=[b"escrow",escrow.buyer.as_ref(),&escrow.nonce],bump=escrow.bump)]pub escrow:Box<Account<'info,Escrow>>,
 #[account(address=USDC)]pub mint:Box<Account<'info,Mint>>,
 #[account(mut,token::mint=mint,token::authority=buyer)]pub buyer_tokens:Box<Account<'info,TokenAccount>>,
 #[account(mut,seeds=[b"vault",escrow.key().as_ref()],bump,token::mint=mint,token::authority=escrow)]pub vault:Box<Account<'info,TokenAccount>>,pub token_program:Program<'info,Token>
}
#[derive(Accounts)]
pub struct Release<'info>{
 pub verifier:Signer<'info>,
 #[account(mut,has_one=verifier,has_one=buyer,seeds=[b"escrow",escrow.buyer.as_ref(),&escrow.nonce],bump=escrow.bump)]pub escrow:Box<Account<'info,Escrow>>,
 #[account(mut)]pub buyer:SystemAccount<'info>,#[account(address=USDC)]pub mint:Box<Account<'info,Mint>>,
 #[account(mut,seeds=[b"vault",escrow.key().as_ref()],bump,token::mint=mint,token::authority=escrow)]pub vault:Box<Account<'info,TokenAccount>>,
 #[account(mut,token::mint=mint,token::authority=escrow.contributor)]pub contributor_tokens:Box<Account<'info,TokenAccount>>,
 #[account(mut,token::mint=mint,token::authority=escrow.platform)]pub platform_tokens:Box<Account<'info,TokenAccount>>,
 #[account(mut,token::mint=mint,token::authority=buyer)]pub buyer_tokens:Box<Account<'info,TokenAccount>>,pub token_program:Program<'info,Token>
}
#[derive(Accounts)]
pub struct Refund<'info>{
 #[account(mut)]pub buyer:Signer<'info>,#[account(mut,has_one=buyer,seeds=[b"escrow",escrow.buyer.as_ref(),&escrow.nonce],bump=escrow.bump)]pub escrow:Box<Account<'info,Escrow>>,
 #[account(address=USDC)]pub mint:Box<Account<'info,Mint>>,
 #[account(mut,seeds=[b"vault",escrow.key().as_ref()],bump,token::mint=mint,token::authority=escrow)]pub vault:Box<Account<'info,TokenAccount>>,
 #[account(mut,token::mint=mint,token::authority=buyer)]pub buyer_tokens:Box<Account<'info,TokenAccount>>,pub token_program:Program<'info,Token>
}
#[error_code]
pub enum EscrowError{#[msg("Invalid immutable terms")]Terms,#[msg("Invalid state, deadline or terms hash")]State,#[msg("Vault balance is insufficient")]Balance}
