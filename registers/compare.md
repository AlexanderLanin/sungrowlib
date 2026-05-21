# Sungrow Register Catalog Comparison

| Source | Registers | Matched | Missing | Unique |
|--------|----------:|--------:|--------:|-------:|
| **sungrowlib** | 334 | — | — | — |
| [mkaiser](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml) | 99 | 89 | 10 | 238 |
| [sungather](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml) | 247 | 239 | 0 | 88 |

## mkaiser

### Missing from sungrowlib (10)

| Address | Type | Name | Data Type | Scale | Unit |
|--------:|------|------|-----------|------:|------|
| [2582](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L18) | read | sg_version_1 | UTF-8 |  |  |
| [2597](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L30) | read | sg_version_2 | UTF-8 |  |  |
| [2613](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L42) | read | sg_version_3 | UTF-8 |  |  |
| [2629](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L54) | read | sg_version_4_battery | UTF-8 |  |  |
| [5741](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L613) | read | sg_meter_phase_a_voltage | S16 | 0.1 | V |
| [5742](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L627) | read | sg_meter_phase_b_voltage | S16 | 0.1 | V |
| [5743](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L641) | read | sg_meter_phase_c_voltage | S16 | 0.1 | V |
| [5744](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L655) | read | sg_meter_phase_a_current | U16 | 0.01 | A |
| [5745](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L669) | read | sg_meter_phase_b_current | U16 | 0.01 | A |
| [5746](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L683) | read | sg_meter_phase_c_current | U16 | 0.01 | A |

### Differences (24)

| Address | Type | Register | Field | Ours | Theirs |
|--------:|------|----------|-------|------|--------|
| [13074](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L1209) | hold | feed_in_limitation_value / sg_export_power_limit | scale | None | 1 |
| [13100](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L1271) | hold | reserved_soc_for_backup / sg_battery_reserved_soc_for_backup | scale | None | 1 |
| [5001](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L121) | read | nominal_output_power / sg_inverter_rated_output | scale | 0.1 | 100 |
| [5001](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L121) | read | nominal_output_power / sg_inverter_rated_output | unit | kW | W |
| [5017](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L259) | read | total_dc_power / sg_total_dc_power | scale | None | 1 |
| [5033](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L312) | read | total_reactive_power / sg_reactive_power | scale | None | 1 |
| [5033](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L312) | read | total_reactive_power / sg_reactive_power | unit | var | W |
| [5035](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L326) | read | power_factor / sg_power_factor | unit | % | None |
| [5214](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L372) | read | battery_power / sg_battery_power | scale | None | 1 |
| [5601](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L401) | read | meter_active_power / sg_meter_active_power | scale | None | 1 |
| [5603](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L418) | read | meter_phase_a_active_power / sg_meter_phase_a_active_power | scale | None | 1 |
| [5605](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L435) | read | meter_phase_b_active_power / sg_meter_phase_b_active_power | scale | None | 1 |
| [5607](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L452) | read | meter_phase_c_active_power / sg_meter_phase_c_active_power | scale | None | 1 |
| [5635](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L521) | read | max_charging_current_bms / sg_bms_max_charging_current | scale | None | 1 |
| [5636](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L534) | read | max_discharging_current_bms / sg_bms_max_discharging_current | scale | None | 1 |
| [5723](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L559) | read | phase_a_backup_power / sg_backup_phase_a_power | scale | None | 1 |
| [5724](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L572) | read | phase_b_backup_power / sg_backup_phase_b_power | scale | None | 1 |
| [5725](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L585) | read | phase_c_backup_power / sg_backup_phase_c_power | scale | None | 1 |
| [5726](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L598) | read | total_backup_power / sg_total_backup_power | scale | None | 1 |
| [13000](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L699) | read | running_state / uid_sg_running_state_raw | scale | None | 1 |
| [13001](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L713) | read | state_power_generated_from_load / uid_power_flow_status | scale | None | 1 |
| [13008](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L778) | read | load_power / sg_load_power | scale | None | 1 |
| [13010](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L794) | read | export_power / sg_battery_export_power_raw | scale | None | 1 |
| [13034](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant/blob/main/modbus_sungrow.yaml#L1017) | read | total_active_power_hybrid / sg_total_active_power | scale | None | 1 |

## sungather


### Differences (36)

| Address | Type | Register | Field | Ours | Theirs |
|--------:|------|----------|-------|------|--------|
| [5000](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1684) | hold | year | unit | None | YYYY |
| [5001](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1689) | hold | month | unit | None | MM |
| [5002](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1694) | hold | day | unit | None | DD |
| [5003](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1699) | hold | hour | unit | None | HH |
| [5004](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1704) | hold | minute | unit | None | MM |
| [5005](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1709) | hold | second | unit | None | SS |
| [5040](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1850) | hold | reactive_power_adjustment | scale | 100 | 0.1 |
| [5040](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1850) | hold | reactive_power_adjustment | unit | var | kVar |
| [13052](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L1917) | hold | charge_discharge_power | scale | None | 1 |
| [4954](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L15) | read | arm_software_version | data_type | UTF-8 | U16 |
| [4969](https://github.com/bohdan-s/SunGather/blob/main/SunGather/registers-sungrow.yaml#L20) | read | dsp_software_version | data_type | UTF-8 | U16 |
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
