# Sungrow Register Catalog Comparison

| Source | Registers | Matched | Missing | Unique |
|--------|----------:|--------:|--------:|-------:|
| **sungrowlib** | 344 | — | — | — |
| [mkaiser](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml) | 99 | 99 | 0 | 238 |
| [sungather](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml) | 247 | 239 | 0 | 98 |

## mkaiser


### Differences (2)

| Address | Type | Register | Field | Ours | Theirs |
|--------:|------|----------|-------|------|--------|
| [5033](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L312) | read | total_reactive_power / sg_reactive_power | unit | var | W |
| [5035](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L326) | read | power_factor / sg_power_factor | unit | % | None |

## sungather


### Differences (41)

| Address | Type | Register | Field | Ours | Theirs |
|--------:|------|----------|-------|------|--------|
| [5000](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1684) | hold | year | unit | None | YYYY |
| [5001](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1689) | hold | month | unit | None | MM |
| [5002](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1694) | hold | day | unit | None | DD |
| [5003](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1699) | hold | hour | unit | None | HH |
| [5004](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1704) | hold | minute | unit | None | MM |
| [5005](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1709) | hold | second | unit | None | SS |
| [5016](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1786) | hold | installed_pv_power | scale | 10 | 0.01 |
| [5016](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1786) | hold | installed_pv_power | unit | W | KW |
| [5039](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1844) | hold | power_limitation_adjustment | scale | 100 | 0.1 |
| [5039](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1844) | hold | power_limitation_adjustment | unit | W | kW |
| [5040](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1850) | hold | reactive_power_adjustment | scale | 100 | 0.1 |
| [5040](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1850) | hold | reactive_power_adjustment | unit | var | kVar |
| [4954](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L15) | read | arm_software_version | data_type | UTF-8 | U16 |
| [4969](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L20) | read | dsp_software_version | data_type | UTF-8 | U16 |
| [5001](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L222) | read | nominal_output_power / nominal_active_power | scale | 100 | 0.1 |
| [5001](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L222) | read | nominal_output_power / nominal_active_power | unit | W | kW |
| [5004](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L245) | read | total_output_energy / total_power_yields | scale | 0.1 | None |
| [5031](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L361) | read | total_active_power | data_type | S32 | U32 |
| [5033](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L367) | read | total_reactive_power | unit | var | Var |
| [5035](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L372) | read | power_factor | unit | % | None |
| [5049](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L455) | read | nominal_reactive_power | scale | 100 | 0.1 |
| [5049](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L455) | read | nominal_reactive_power | unit | var | kVar |
| [5079](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L482) | read | reactive_power_regulation_setpoint | unit | var | Var |
| [5726](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L900) | read | total_backup_power | data_type | S32 | S16 |
| [6227](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L919) | read | monthly_pv_energy_yields | scale | 0.1 | None |
| [6250](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L925) | read | yearly_pv_energy_yields | data_type | U32 | U16 |
| [6429](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L952) | read | yearly_direct_energy_consumption_from_pv / direct_power_consumption_yearly_pv | data_type | U32 | U16 |
| [6608](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L979) | read | yearly_export_energy_from_pv / export_power_from_pv_yearly | data_type | U32 | U16 |
| [6787](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1007) | read | yearly_battery_charge_energy_from_pv / battery_charge_power_from_pv_yearly | data_type | U32 | U16 |
| [13021](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1342) | read | battery_current_legacy / battery_current | data_type | U16 | S16 |
| [13022](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1349) | read | battery_power_legacy / battery_power | data_type | U16 | S16 |
| [13050](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1488) | read | inverter_alarm | scale | None | 0.1 |
| [13052](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1494) | read | grid_side_fault / grid-side_fault | scale | None | 0.1 |
| [13054](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1500) | read | system_fault_1 / system_fault1 | scale | None | 0.1 |
| [13056](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1506) | read | system_fault_2 / system_fault2 | scale | None | 0.1 |
| [13058](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1512) | read | dc_side_fault / dc-side_fault | scale | None | 0.1 |
| [13060](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1518) | read | permanent_fault | scale | None | 0.1 |
| [13062](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1524) | read | bdc_side_fault / bdc-side_fault | scale | None | 0.1 |
| [13064](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1530) | read | bdc_side_permanent_fault / bdc-side_permanent_fault | scale | None | 0.1 |
| [13066](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1536) | read | battery_fault | scale | None | 0.1 |
| [13068](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1542) | read | battery_alarm | scale | None | 0.1 |
