// @flow

import { lt } from 'biggystring'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSpendInfo,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'
import { Router, Token } from 'spookyswap-sdk'

import {
  checkInvalidCodes,
  makeSwapPluginQuote,
  safeCurrencyCodes
} from '../swap-helpers.js'

const INVALID_CURRENCY_CODES = {
  from: {},
  to: {}
}

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const CURRENCY_CODE_TRANSCRIPTION = {
  // Edge currencyCode: exchangeCurrencyCode
  ETH: {
    USDT: 'USDT20'
  }
}

const pluginId = 'spookySwap'

const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'SpookySwap',
  supportEmail: '',
  supportUrl: 'https://discord.com/invite/weXbvPAH4Q'
}
const expirationMs = 1000 * 60 * 60

const dontUseLegacy = {}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({
    currencyCode
  })

  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

export function makeSpookySwapPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io } = opts
  const { fetchCors = io.fetch } = io

  async function call(route: string, params: any) {
    this.log(
      '\x1b[34m\x1b[43m' +
        `testFnCall: ${JSON.stringify('testFnCall', null, 2)}` +
        '\x1b[0m'
    )
    // const body = JSON.stringify(params)

    // const headers: { [header: string]: string } = {
    //   Accept: 'application/json',
    //   'Content-Type': 'application/json',
    //   Authorization: `${apiKey}`
    // }

    // const response = await fetchCors(uri + route, {
    //   method: 'POST',
    //   body,
    //   headers
    // })

    // if (!response.ok) {
    //   if (response.status === 422) {
    //     throw new SwapCurrencyError(swapInfo, params.coin_from, params.coin_to)
    //   }
    //   throw new Error(`Exolix returned error code ${response.status}`)
    // }

    // return response.json()
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      this.log(
        '\x1b[34m\x1b[43m' +
          `'fetchSwapQuote': ${JSON.stringify('fetchSwapQuote', null, 2)}` +
          '\x1b[0m'
      )
      checkInvalidCodes(INVALID_CURRENCY_CODES, request, swapInfo)

      const fixedPromise = this.getFixedQuote(request, userSettings)

      const fixedResult = await fixedPromise
      return fixedResult
    },

    async getFixedQuote(
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapQuote> {
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      const { safeFromCurrencyCode, safeToCurrencyCode } = safeCurrencyCodes(
        CURRENCY_CODE_TRANSCRIPTION,
        request
      )

      // Swap the currencies if we need a reverse quote:
      const quoteParams =
        request.quoteFor === 'from'
          ? {
              coin_from: safeFromCurrencyCode,
              coin_to: safeToCurrencyCode,
              deposit_amount: quoteAmount,
              rate_type: 'fixed'
            }
          : {
              coin_from: safeToCurrencyCode,
              coin_to: safeFromCurrencyCode,
              deposit_amount: quoteAmount,
              rate_type: 'fixed'
            }

      // Get Rate
      const rateResponse = await call('rate', quoteParams)

      // Check rate minimum:
      const nativeMin = await request.fromWallet.denominationToNative(
        rateResponse.min_amount,
        request.fromCurrencyCode
      )

      if (lt(request.nativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      // Make the transaction:
      const exchangeParams = {
        coin_from: quoteParams.coin_from,
        coin_to: quoteParams.coin_to,
        deposit_amount: quoteAmount,
        destination_address: toAddress,
        destination_extra: '',
        refund_address: fromAddress,
        refund_extra: '',
        rate_type: 'fixed'
      }

      const quoteInfo = await call('exchange', exchangeParams)

      const fromNativeAmount = await request.fromWallet.denominationToNative(
        quoteInfo.amount_from.toString(),
        request.fromCurrencyCode
      )

      const toNativeAmount = await request.fromWallet.denominationToNative(
        quoteInfo.amount_to.toString(),
        request.toCurrencyCode
      )

      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: quoteInfo.deposit_address,
            uniqueIdentifier: quoteInfo.deposit_extra || undefined
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard',
        swapData: {
          orderId: quoteInfo.id,
          orderUri: orderUri + quoteInfo.id,
          isEstimate: false,
          payoutAddress: toAddress,
          payoutCurrencyCode: request.toCurrencyCode,
          payoutNativeAmount: toNativeAmount,
          payoutWalletId: request.toWallet.id,
          plugin: {
            ...swapInfo
          },
          refundAddress: fromAddress
        }
      }

      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        pluginId,
        false,
        new Date(Date.now() + expirationMs),
        quoteInfo.id
      )
    }
  }

  return out
}
